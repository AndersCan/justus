import { Actor, RealClock, event, state } from "@mantaq/core";
import { atom, computed } from "nanostores";
import type { JoinRequest } from "@justus/core";
import { gateway } from "../gateway";
import { bindStateAtoms, runInvoke } from "./actor-utils";

/**
 * Join-request inbox: pending "<name> wants to join <folder>" requests shown
 * to this device's folder creators, each with Yes/No. Same actor pattern as
 * the other machines.
 */

const REQUESTS_STATES = ["idle", "refreshing", "ok", "responding", "error"] as const;
export type RequestsStateName = (typeof REQUESTS_STATES)[number];

export const $requests = atom<JoinRequest[]>([]);
export const $requestsState = atom<RequestsStateName>("idle");
export const $requestsError = atom<string | null>(null);
export const $requestsFatal = atom(false);

export const $requestsViewModel = computed(
  [$requests, $requestsState, $requestsError, $requestsFatal],
  (requests, state, error, fatal) => ({
    requests,
    state,
    responding: state === "responding",
    error,
    fatal,
  }),
);

const idle = state("idle")();
const refreshing = state("refreshing")();
const ok = state("ok")();
const responding = state("responding")();
const error = state("error")();

const refresh = event("REFRESH")();
const loaded = event("LOADED")<{ requests: JoinRequest[] }>();
const loadFailed = event("LOAD_FAILED")<{ message: string }>();
const respond = event("RESPOND")<{ folderId: string; requesterKey: string; approve: boolean }>();
const responded = event("RESPONDED")<{ folderId: string; requesterKey: string }>();
const respondFailed = event("RESPOND_FAILED")<{ message: string }>();
const retry = event("RETRY")();

type RequestsContext = {
  pendingRespond: { folderId: string; requesterKey: string; approve: boolean } | null;
};

const requestsActor = new Actor({
  inputs: [refresh, respond, retry],
  internal: [loaded, loadFailed, responded, respondFailed],
  outputs: [],
  states: [idle, refreshing, ok, responding, error],
  initial: idle,
  clock: new RealClock(),
  context: {
    pendingRespond: null,
  } as RequestsContext,
  setup: (m) => {
    m.on(idle, refresh, () => {
      $requestsError.set(null);
      return { state: refreshing };
    });
    m.on(ok, refresh, () => {
      $requestsError.set(null);
      return { state: refreshing };
    });
    m.on(error, refresh, () => {
      $requestsError.set(null);
      return { state: refreshing };
    });
    m.on(error, retry, () => {
      $requestsError.set(null);
      return { state: refreshing };
    });

    m.effect(refreshing, ({ signal, emit }) => {
      return runInvoke(
        signal,
        () => gateway.requests(),
        (result) => {
          const requests = (result as { requests?: JoinRequest[] } | null)?.requests;
          if (!requests) {
            emit(loadFailed.create({ message: "requests returned no data" }));
            return;
          }
          emit(loaded.create({ requests }));
        },
        (message) => emit(loadFailed.create({ message })),
      );
    });
    m.on(refreshing, loaded, (e) => {
      $requests.set(e.payload.requests);
      $requestsError.set(null);
      return { state: ok };
    });
    m.on(refreshing, loadFailed, (e) => {
      $requestsError.set(e.payload.message);
      return { state: error };
    });

    m.on(ok, respond, (e, opts) => {
      $requestsError.set(null);
      opts.context.set({
        pendingRespond: {
          folderId: e.payload.folderId,
          requesterKey: e.payload.requesterKey,
          approve: e.payload.approve,
        },
      });
      return { state: responding };
    });
    m.effect(responding, ({ signal, emit, context }) => {
      const pending = context.get().pendingRespond;
      if (!pending) {
        emit(respondFailed.create({ message: "no pending response" }));
        return;
      }
      return runInvoke(
        signal,
        () => gateway.respond(pending.folderId, pending.requesterKey, pending.approve),
        () =>
          emit(
            responded.create({
              folderId: pending.folderId,
              requesterKey: pending.requesterKey,
            }),
          ),
        (message) => emit(respondFailed.create({ message })),
      );
    });
    m.on(responding, responded, (e, opts) => {
      $requestsError.set(null);
      $requests.set($requests.get().filter((r) => r.requesterKey !== e.payload.requesterKey));
      opts.context.set({ pendingRespond: null });
      return { state: ok };
    });
    m.on(responding, respondFailed, (e, opts) => {
      $requestsError.set(e.payload.message);
      opts.context.set({ pendingRespond: null });
      return { state: ok };
    });
  },
});

const { state: stateName } = bindStateAtoms({
  actor: requestsActor,
  states: REQUESTS_STATES,
  $state: $requestsState,
  $error: $requestsError,
  $fatal: $requestsFatal,
});

export const requests = {
  state: stateName,
  refresh: () => requestsActor.send(refresh.create()),
  respond: (folderId: string, requesterKey: string, approve: boolean) =>
    requestsActor.send(respond.create({ folderId, requesterKey, approve })),
  retry: () => requestsActor.send(retry.create()),
};
