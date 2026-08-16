import { Actor, RealClock, event, state } from "@mantaq/core";
import { atom, computed } from "nanostores";
import type { SyncStatus } from "@justus/core";
import { gateway } from "../gateway";
import { bindStateAtoms, runInvoke } from "./actor-utils";

/**
 * The sync/join state machine: folder status, reader join, creator enroll.
 * Same pattern as the gallery — a mantaq actor whose context holds the
 * in-flight join/enroll params the effects read, with every invoke wrapped
 * so transport failures become failure events.
 */

const SYNC_STATES = ["idle", "refreshing", "ok", "joining", "enrolling", "error"] as const;
export type SyncStateName = (typeof SYNC_STATES)[number];

export const $syncStatus = atom<SyncStatus | null>(null);
export const $syncState = atom<SyncStateName>("idle");
export const $syncError = atom<string | null>(null);
/** True only for mantaq's universal `__error`: the machine is dead and Retry
 * cannot help — the UI must offer a reload instead. */
export const $syncFatal = atom(false);

/** Plain view model for the sync UI (see $galleryViewModel). `busy` is
 * derived: it is exactly "a join or enroll is in flight". */
export const $syncViewModel = computed(
  [$syncStatus, $syncState, $syncError, $syncFatal],
  (status, state, error, fatal) => ({
    status,
    state,
    busy: state === "joining" || state === "enrolling",
    error,
    fatal,
  }),
);

const idle = state("idle")();
const refreshing = state("refreshing")();
const ok = state("ok")();
const joining = state("joining")();
const enrolling = state("enrolling")();
const error = state("error")();

const refresh = event("REFRESH")();
const status = event("STATUS")<{ status: SyncStatus }>();
const statusFailed = event("STATUS_FAILED")<{ message: string }>();
const join = event("JOIN")<{ key: string }>();
const joined = event("JOINED")<{ status: SyncStatus }>();
const joinFailed = event("JOIN_FAILED")<{ message: string }>();
const enroll = event("ENROLL")<{ key: string; name: string }>();
const enrolled = event("ENROLLED")<{ status: SyncStatus }>();
const enrollFailed = event("ENROLL_FAILED")<{ message: string }>();
const retry = event("RETRY")();

type SyncContext = {
  pendingJoin: string | null;
  pendingEnroll: { key: string; name: string } | null;
};

const syncActor = new Actor({
  inputs: [refresh, join, enroll, retry],
  internal: [status, statusFailed, joined, joinFailed, enrolled, enrollFailed],
  outputs: [],
  states: [idle, refreshing, ok, joining, enrolling, error],
  initial: idle,
  clock: new RealClock(),
  context: {
    pendingJoin: null,
    pendingEnroll: null,
  } as SyncContext,
  setup: (m) => {
    m.on(idle, refresh, () => {
      $syncError.set(null);
      return { state: refreshing };
    });
    m.on(ok, refresh, () => {
      $syncError.set(null);
      return { state: refreshing };
    });
    m.on(error, refresh, () => {
      $syncError.set(null);
      return { state: refreshing };
    });
    m.on(error, retry, () => {
      $syncError.set(null);
      return { state: refreshing };
    });

    m.effect(refreshing, ({ signal, emit }) => {
      return runInvoke(
        signal,
        () => gateway.status(),
        (result) =>
          result
            ? emit(status.create({ status: result as SyncStatus }))
            : emit(statusFailed.create({ message: "no status returned" })),
        (message) => emit(statusFailed.create({ message })),
      );
    });
    m.on(refreshing, status, (e, opts) => {
      $syncStatus.set(e.payload.status);
      $syncError.set(null);
      opts.context.set({ pendingJoin: null, pendingEnroll: null });
      return { state: ok };
    });
    m.on(refreshing, statusFailed, (e, opts) => {
      $syncError.set(e.payload.message);
      opts.context.set({ pendingJoin: null, pendingEnroll: null });
      return { state: error };
    });

    m.on(ok, join, (e, opts) => {
      $syncError.set(null);
      opts.context.set({ pendingJoin: e.payload.key, pendingEnroll: null });
      return { state: joining };
    });
    m.effect(joining, ({ signal, emit, context }) => {
      const key = context.get().pendingJoin;
      if (!key) {
        emit(joinFailed.create({ message: "no pending join key" }));
        return;
      }
      return runInvoke(
        signal,
        () => gateway.join(key),
        (result) =>
          result
            ? emit(joined.create({ status: result as SyncStatus }))
            : emit(joinFailed.create({ message: "join returned no status" })),
        (message) => emit(joinFailed.create({ message })),
      );
    });
    m.on(joining, joined, (e, opts) => {
      $syncError.set(null);
      $syncStatus.set(e.payload.status);
      opts.context.set({ pendingJoin: null, pendingEnroll: null });
      return { state: ok };
    });
    m.on(joining, joinFailed, (e, opts) => {
      $syncError.set(e.payload.message);
      opts.context.set({ pendingJoin: null, pendingEnroll: null });
      return { state: ok };
    });

    m.on(ok, enroll, (e, opts) => {
      $syncError.set(null);
      opts.context.set({
        pendingEnroll: { key: e.payload.key, name: e.payload.name },
        pendingJoin: null,
      });
      return { state: enrolling };
    });
    m.effect(enrolling, ({ signal, emit, context }) => {
      const pending = context.get().pendingEnroll;
      if (!pending) {
        emit(enrollFailed.create({ message: "no pending enrollment" }));
        return;
      }
      return runInvoke(
        signal,
        () => gateway.enroll(pending.key, pending.name),
        (result) =>
          result
            ? emit(enrolled.create({ status: result as SyncStatus }))
            : emit(enrollFailed.create({ message: "enroll returned no status" })),
        (message) => emit(enrollFailed.create({ message })),
      );
    });
    m.on(enrolling, enrolled, (e, opts) => {
      $syncError.set(null);
      $syncStatus.set(e.payload.status);
      opts.context.set({ pendingJoin: null, pendingEnroll: null });
      return { state: ok };
    });
    m.on(enrolling, enrollFailed, (e, opts) => {
      $syncError.set(e.payload.message);
      opts.context.set({ pendingJoin: null, pendingEnroll: null });
      return { state: ok };
    });
  },
});

const { state: stateName } = bindStateAtoms({
  actor: syncActor,
  states: SYNC_STATES,
  $state: $syncState,
  $error: $syncError,
  $fatal: $syncFatal,
});

export const sync = {
  state: stateName,
  refresh: () => syncActor.send(refresh.create()),
  join: (key: string) => syncActor.send(join.create({ key })),
  enroll: (key: string, name: string) => syncActor.send(enroll.create({ key, name })),
  retry: () => syncActor.send(retry.create()),
};
