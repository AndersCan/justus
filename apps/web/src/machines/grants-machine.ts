import { Actor, RealClock, event, state } from "@mantaq/core";
import { atom, computed } from "nanostores";
import type { GrantRecord } from "@justus/core";
import { gateway } from "../gateway";
import { bindStateAtoms, runInvoke } from "./actor-utils";

/**
 * Share surface: the local grant ledger this device serves photos to, plus the
 * once-daily unknown-holder prompt. Same actor pattern as the requests machine.
 * The ledger is local and durable, so every action works offline; the UI only
 * re-reads after acting to reflect the new state.
 */

type GrantActionKind = "grant" | "decline" | "snooze" | "revoke";

const GRANTS_STATES = ["idle", "refreshing", "ok", "acting", "error"] as const;
export type GrantsStateName = (typeof GRANTS_STATES)[number];

export const $grantsRecords = atom<GrantRecord[]>([]);
export const $grantsDue = atom<string[]>([]);
export const $grantsState = atom<GrantsStateName>("idle");
export const $grantsError = atom<string | null>(null);
export const $grantsFatal = atom(false);

function dueRecords(records: GrantRecord[], due: string[]): GrantRecord[] {
  const dueSet = new Set(due);
  return records.filter((r) => dueSet.has(r.peerId));
}

export const $grantsViewModel = computed(
  [$grantsRecords, $grantsDue, $grantsState, $grantsError, $grantsFatal],
  (records, due, state, error, fatal) => ({
    records,
    due,
    dueRecords: dueRecords(records, due),
    state,
    acting: state === "acting",
    error,
    fatal,
  }),
);

const idle = state("idle")();
const refreshing = state("refreshing")();
const ok = state("ok")();
const acting = state("acting")();
const error = state("error")();

const refresh = event("REFRESH")();
const loaded = event("LOADED")<{ records: GrantRecord[]; due: string[] }>();
const loadFailed = event("LOAD_FAILED")<{ message: string }>();
const act = event("ACT")<{ peerId: string; kind: GrantActionKind }>();
const acted = event("ACTED")();
const actFailed = event("ACT_FAILED")<{ message: string }>();
const retry = event("RETRY")();

type GrantsContext = {
  pendingAct: { peerId: string; kind: GrantActionKind } | null;
};

const grantsActor = new Actor({
  inputs: [refresh, act, retry],
  internal: [loaded, loadFailed, acted, actFailed],
  outputs: [],
  states: [idle, refreshing, ok, acting, error],
  initial: idle,
  clock: new RealClock(),
  context: {
    pendingAct: null,
  } as GrantsContext,
  setup: (m) => {
    m.on(idle, refresh, () => {
      $grantsError.set(null);
      return { state: refreshing };
    });
    m.on(ok, refresh, () => {
      $grantsError.set(null);
      return { state: refreshing };
    });
    m.on(error, refresh, () => {
      $grantsError.set(null);
      return { state: refreshing };
    });
    m.on(error, retry, () => {
      $grantsError.set(null);
      return { state: refreshing };
    });

    m.effect(refreshing, ({ signal, emit }) => {
      return runInvoke(
        signal,
        () => gateway.grants.view(),
        (result) => {
          const view = (result as { records?: GrantRecord[]; due?: string[] } | null) ?? {};
          emit(
            loaded.create({
              records: view.records ?? [],
              due: view.due ?? [],
            }),
          );
        },
        (message) => emit(loadFailed.create({ message })),
      );
    });
    m.on(refreshing, loaded, (e) => {
      $grantsRecords.set(e.payload.records);
      $grantsDue.set(e.payload.due);
      $grantsError.set(null);
      return { state: ok };
    });
    m.on(refreshing, loadFailed, (e) => {
      $grantsError.set(e.payload.message);
      return { state: error };
    });

    m.on(ok, act, (e, opts) => {
      $grantsError.set(null);
      opts.context.set({ pendingAct: { peerId: e.payload.peerId, kind: e.payload.kind } });
      return { state: acting };
    });
    m.effect(acting, ({ signal, emit, context }) => {
      const pending = context.get().pendingAct;
      if (!pending) {
        emit(actFailed.create({ message: "no pending action" }));
        return;
      }
      const work =
        pending.kind === "grant"
          ? () => gateway.grants.grant(pending.peerId)
          : pending.kind === "decline"
            ? () => gateway.grants.decline(pending.peerId)
            : pending.kind === "revoke"
              ? () => gateway.grants.revoke(pending.peerId)
              : () => gateway.grants.snooze();
      return runInvoke(
        signal,
        work,
        () => emit(acted.create()),
        (message) => emit(actFailed.create({ message })),
      );
    });
    m.on(acting, acted, (_e, opts) => {
      $grantsError.set(null);
      opts.context.set({ pendingAct: null });
      return { state: refreshing };
    });
    m.on(acting, actFailed, (e, opts) => {
      $grantsError.set(e.payload.message);
      opts.context.set({ pendingAct: null });
      return { state: ok };
    });
  },
});

const { state: stateName } = bindStateAtoms({
  actor: grantsActor,
  states: GRANTS_STATES,
  $state: $grantsState,
  $error: $grantsError,
  $fatal: $grantsFatal,
});

export const grants = {
  state: stateName,
  refresh: () => grantsActor.send(refresh.create()),
  grant: (peerId: string) => grantsActor.send(act.create({ peerId, kind: "grant" })),
  decline: (peerId: string) => grantsActor.send(act.create({ peerId, kind: "decline" })),
  revoke: (peerId: string) => grantsActor.send(act.create({ peerId, kind: "revoke" })),
  snooze: () => grantsActor.send(act.create({ peerId: "", kind: "snooze" })),
  retry: () => grantsActor.send(retry.create()),
};
