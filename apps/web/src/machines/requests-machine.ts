import { Actor, RealClock, event, state } from "@mantaq/core";
import { atom, computed } from "nanostores";
import type { JoinRequest } from "@justus/core";
import { gateway } from "../gateway";
import { bindStateAtoms, runInvoke } from "./actor-utils";
import { removeRequestFromList } from "./requests-list";

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

/** The inbox of requests to join the person's folders has not been loaded yet. */
const idle = state("idle")();
/** Loading the requests from people who want to join. */
const refreshing = state("refreshing")();
/** The requests are shown, each with Yes and No. */
const ok = state("ok")();
/** Sending the person's Yes or No; buttons are disabled meanwhile. */
const responding = state("responding")();
/** The requests could not be loaded; the person sees the problem and can try again. */
const error = state("error")();

/** The person opens the requests inbox or asks it to reload. */
const refresh = event("REFRESH")();
/** The list of requests came back. */
const loaded = event("LOADED")<{ requests: JoinRequest[] }>();
/** The requests could not be loaded (no answer, or the app could not reach them). */
const loadFailed = event("LOAD_FAILED")<{ message: string }>();
/** The person taps Yes or No on a request. */
const respond = event("RESPOND")<{ folderId: string; requesterKey: string; approve: boolean }>();
/** The answer was sent. */
const responded = event("RESPONDED")<{ folderId: string; requesterKey: string }>();
/** The answer could not be sent. */
const respondFailed = event("RESPOND_FAILED")<{ message: string }>();
/** The person taps Try again after an error. */
const retry = event("RETRY")();

type RequestsContext = {
  pendingRespond: { folderId: string; requesterKey: string; approve: boolean } | null;
};

export const requestsActor = Actor({
  inputs: [refresh, respond, retry],
  internal: [loaded, loadFailed, responded, respondFailed],
  outputs: [],
  states: [idle, refreshing, ok, responding, error],
  initial: idle,
  clock: RealClock(),
  context: {
    pendingRespond: null,
  } as RequestsContext,
  setup: (m) => {
    /** The first load starts and any old error is cleared. */
    m.on(idle, {
      event: refresh,
      to: [refreshing],
      handler: () => {
        $requestsError.set(null);
        return { state: refreshing };
      },
    });
    /** A reload starts and any old error is cleared. */
    m.on(ok, {
      event: refresh,
      to: [refreshing],
      handler: () => {
        $requestsError.set(null);
        return { state: refreshing };
      },
    });
    /** A reload after an error starts and the error message goes away. */
    m.on(error, {
      event: refresh,
      to: [refreshing],
      handler: () => {
        $requestsError.set(null);
        return { state: refreshing };
      },
    });
    /** Try again after an error: loading starts again and the error message goes away. */
    m.on(error, {
      event: retry,
      to: [refreshing],
      handler: () => {
        $requestsError.set(null);
        return { state: refreshing };
      },
    });

    m.effect(refreshing, {
      name: "refreshing",
      fn: ({ signal, emit }) => {
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
      },
    });
    /** The requests are shown. */
    m.on(refreshing, {
      event: loaded,
      to: [ok],
      handler: (e) => {
        $requests.set(e.payload.requests);
        $requestsError.set(null);
        return { state: ok };
      },
    });
    /** Loading failed: the person sees an error and can try again. */
    m.on(refreshing, {
      event: loadFailed,
      to: [error],
      handler: (e) => {
        $requestsError.set(e.payload.message);
        return { state: error };
      },
    });

    /** Sending the Yes or No starts and any earlier error is cleared. */
    m.on(ok, {
      event: respond,
      to: [responding],
      handler: (e, opts) => {
        $requestsError.set(null);
        opts.context.set({
          pendingRespond: {
            folderId: e.payload.folderId,
            requesterKey: e.payload.requesterKey,
            approve: e.payload.approve,
          },
        });
        return { state: responding };
      },
    });
    m.effect(responding, {
      name: "responding",
      fn: ({ signal, emit, context }) => {
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
      },
    });
    /** The answer went through and that request disappears from the list. */
    m.on(responding, {
      event: responded,
      to: [ok],
      handler: (e, opts) => {
        $requestsError.set(null);
        $requests.set(
          removeRequestFromList($requests.get(), e.payload.folderId, e.payload.requesterKey),
        );
        opts.context.set({ pendingRespond: null });
        return { state: ok };
      },
    });
    /** Sending failed: the person sees an error and the request stays in the list. */
    m.on(responding, {
      event: respondFailed,
      to: [ok],
      handler: (e, opts) => {
        $requestsError.set(e.payload.message);
        opts.context.set({ pendingRespond: null });
        return { state: ok };
      },
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
