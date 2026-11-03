import { Actor, RealClock, event, state, type Clock } from "@mantaq/core";
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
/** Set when the last join landed as a *pending request* (the folder was added
 * read-only and the requester is awaiting the creator's approval). The sync
 * UI uses it to explain the outcome instead of navigating away. */
export const $pendingJoin = atom(false);

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

/** Nothing has been checked yet; the folder status is unknown. */
const idle = state("idle")();
/** Checking the current state of the shared folder. */
const refreshing = state("refreshing")();
/** The folder status is up to date and the person can join or add a folder. */
const ok = state("ok")();
/** Joining a shared folder from an invite; a spinner shows until it finishes. */
const joining = state("joining")();
/** Adding a folder of the person's own to share; a spinner shows until it finishes. */
const enrolling = state("enrolling")();
/** Checking the folder failed; the person sees the problem and can try again. */
const error = state("error")();

/** The person opens the sharing screen or asks it to reload. */
const refresh = event("REFRESH")();
/** The folder status came back. */
const status = event("STATUS")<{ status: SyncStatus }>();
/** The folder status could not be read (no answer, or the app could not reach it). */
const statusFailed = event("STATUS_FAILED")<{ message: string }>();
/** The person joins a folder from an invite, with an optional name. */
const join = event("JOIN")<{ key: string; name?: string }>();
/** Joining finished; the folder may be ready, or waiting for the owner's approval. */
const joined = event("JOINED")<{ status: SyncStatus }>();
/** Joining did not work (no answer, or the app could not reach the folder). */
const joinFailed = event("JOIN_FAILED")<{ message: string }>();
/** The person chooses a folder of their own to share, with a name. */
const enroll = event("ENROLL")<{ key: string; name: string }>();
/** The folder is now set up for sharing. */
const enrolled = event("ENROLLED")<{ status: SyncStatus }>();
/** Setting up the folder for sharing did not work. */
const enrollFailed = event("ENROLL_FAILED")<{ message: string }>();
/** The person taps Try again after an error. */
const retry = event("RETRY")();

type SyncContext = {
  status: SyncStatus | null;
  awaitingApproval: boolean;
  error: string | null;
  pendingJoin: { key: string; name?: string } | null;
  pendingEnroll: { key: string; name: string } | null;
};
type SyncPort = Pick<typeof gateway, "status" | "join" | "enroll">;

/** Folder status, join and enroll run through `gateway` and the clock is injected, so tests and the flow inspector can drive it. */
export function createSyncActor(options: { clock: Clock; gateway?: SyncPort }) {
  const port = options.gateway ?? gateway;
  return Actor({
    inputs: [refresh, join, enroll, retry],
    internal: [status, statusFailed, joined, joinFailed, enrolled, enrollFailed],
    outputs: [],
    states: [idle, refreshing, ok, joining, enrolling, error],
    initial: idle,
    clock: options.clock,
    context: {
      status: null,
      awaitingApproval: false,
      error: null,
      pendingJoin: null,
      pendingEnroll: null,
    } as SyncContext,
    setup: (m) => {
      /** The first check starts and any old error is cleared. */
      m.on(idle, {
        event: refresh,
        to: [refreshing],
        handler: (_e, opts) => {
          opts.context.set({ ...opts.context.get(), error: null });
          return { state: refreshing };
        },
      });
      /** A reload starts and any old error is cleared. */
      m.on(ok, {
        event: refresh,
        to: [refreshing],
        handler: (_e, opts) => {
          opts.context.set({ ...opts.context.get(), error: null });
          return { state: refreshing };
        },
      });
      /** A reload after an error starts and the error message goes away. */
      m.on(error, {
        event: refresh,
        to: [refreshing],
        handler: (_e, opts) => {
          opts.context.set({ ...opts.context.get(), error: null });
          return { state: refreshing };
        },
      });
      /** Try again after an error: the check starts again and the error message goes away. */
      m.on(error, {
        event: retry,
        to: [refreshing],
        handler: (_e, opts) => {
          opts.context.set({ ...opts.context.get(), error: null });
          return { state: refreshing };
        },
      });

      /** The folder status is read from the app. */
      m.effect(refreshing, {
        name: "refreshing",
        sends: [status, statusFailed],
        fn: ({ signal, emit }) => {
          return runInvoke(
            signal,
            () => port.status(),
            (result) =>
              result
                ? emit(status.create({ status: result as SyncStatus }))
                : emit(statusFailed.create({ message: "no status returned" })),
            (message) => emit(statusFailed.create({ message })),
          );
        },
      });
      /** The folder status is shown and any error is cleared. */
      m.on(refreshing, {
        event: status,
        to: [ok],
        handler: (e, opts) => {
          opts.context.set({
            ...opts.context.get(),
            status: e.payload.status,
            error: null,
            pendingJoin: null,
            pendingEnroll: null,
          });
          return { state: ok };
        },
      });
      /** The check failed: the person sees an error and can try again. */
      m.on(refreshing, {
        event: statusFailed,
        to: [error],
        handler: (e, opts) => {
          opts.context.set({
            ...opts.context.get(),
            error: e.payload.message,
            pendingJoin: null,
            pendingEnroll: null,
          });
          return { state: error };
        },
      });

      /** Joining starts: any earlier error and any earlier 'waiting for approval' notice are cleared. */
      m.on(ok, {
        event: join,
        to: [joining],
        handler: (e, opts) => {
          opts.context.set({
            ...opts.context.get(),
            error: null,
            awaitingApproval: false,
            pendingJoin: { key: e.payload.key, name: e.payload.name },
            pendingEnroll: null,
          });
          return { state: joining };
        },
      });
      /** The folder is joined through the app, using the invite key. */
      m.effect(joining, {
        name: "joining",
        sends: [joined, joinFailed],
        fn: ({ signal, emit, context }) => {
          const pending = context.get().pendingJoin;
          if (!pending) {
            emit(joinFailed.create({ message: "no pending join key" }));
            return;
          }
          return runInvoke(
            signal,
            () => port.join(pending.key, pending.name),
            (result) =>
              result
                ? emit(joined.create({ status: result as SyncStatus }))
                : emit(joinFailed.create({ message: "join returned no status" })),
            (message) => emit(joinFailed.create({ message })),
          );
        },
      });
      /** Joining worked. If the owner still has to approve, the person is told they are waiting for approval; otherwise the folder is ready. */
      m.on(joining, {
        event: joined,
        to: [ok],
        handler: (e, opts) => {
          opts.context.set({
            ...opts.context.get(),
            error: null,
            status: e.payload.status,
            awaitingApproval: Boolean(e.payload.status.folder?.pending),
            pendingJoin: null,
            pendingEnroll: null,
          });
          return { state: ok };
        },
      });
      /** Joining failed: the person sees an error and stays on the sharing screen to try again. */
      m.on(joining, {
        event: joinFailed,
        to: [ok],
        handler: (e, opts) => {
          opts.context.set({
            ...opts.context.get(),
            error: e.payload.message,
            pendingJoin: null,
            pendingEnroll: null,
          });
          return { state: ok };
        },
      });

      /** Setting up the person's folder for sharing starts and any earlier error is cleared. */
      m.on(ok, {
        event: enroll,
        to: [enrolling],
        handler: (e, opts) => {
          opts.context.set({
            ...opts.context.get(),
            error: null,
            pendingEnroll: { key: e.payload.key, name: e.payload.name },
            pendingJoin: null,
          });
          return { state: enrolling };
        },
      });
      /** The person's folder is set up for sharing through the app. */
      m.effect(enrolling, {
        name: "enrolling",
        sends: [enrolled, enrollFailed],
        fn: ({ signal, emit, context }) => {
          const pending = context.get().pendingEnroll;
          if (!pending) {
            emit(enrollFailed.create({ message: "no pending enrollment" }));
            return;
          }
          return runInvoke(
            signal,
            () => port.enroll(pending.key, pending.name),
            (result) =>
              result
                ? emit(enrolled.create({ status: result as SyncStatus }))
                : emit(enrollFailed.create({ message: "enroll returned no status" })),
            (message) => emit(enrollFailed.create({ message })),
          );
        },
      });
      /** The folder is set up and its status is shown. */
      m.on(enrolling, {
        event: enrolled,
        to: [ok],
        handler: (e, opts) => {
          opts.context.set({
            ...opts.context.get(),
            error: null,
            status: e.payload.status,
            pendingJoin: null,
            pendingEnroll: null,
          });
          return { state: ok };
        },
      });
      /** Setting up failed: the person sees an error and stays on the sharing screen. */
      m.on(enrolling, {
        event: enrollFailed,
        to: [ok],
        handler: (e, opts) => {
          opts.context.set({
            ...opts.context.get(),
            error: e.payload.message,
            pendingJoin: null,
            pendingEnroll: null,
          });
          return { state: ok };
        },
      });
    },
  });
}

export const syncActor = createSyncActor({ clock: RealClock() });

/** Folders also writes `$syncStatus`, so it is only written when this machine produced a new status. */
let lastWrittenStatus: SyncStatus | null = null;
syncActor.on("change", {
  fn: (snapshot) => {
    const { status: current, error: message, awaitingApproval } = snapshot.context;
    $syncError.set(message);
    $pendingJoin.set(awaitingApproval);
    if (current !== null && current !== lastWrittenStatus) {
      lastWrittenStatus = current;
      $syncStatus.set(current);
    }
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
  join: (key: string, name?: string) => syncActor.send(join.create({ key, name })),
  enroll: (key: string, name: string) => syncActor.send(enroll.create({ key, name })),
  retry: () => syncActor.send(retry.create()),
};
