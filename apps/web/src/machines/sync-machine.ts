import { Actor, RealClock, event, state, type Clock, type Snapshot } from "@mantaq/core";
import type { SyncStatus } from "@justus/core";
import { gateway } from "../gateway";
import { fatalErrorOf, runInvoke, stateNameOf } from "./actor-utils";

/**
 * The sync state machine: album status and add by key.
 * Same pattern as the gallery — a mantaq actor whose context holds the
 * in-flight enroll params the effects read, with every invoke wrapped
 * so transport failures become failure events.
 */

export const SYNC_STATES = [
  "albumNotChecked",
  "checkingAlbum",
  "showingAlbum",
  "waitingForAdminApproval",
  "addingMemberByKey",
  "couldNotAddMember",
  "couldNotCheckAlbum",
] as const;
export type SyncStateName = (typeof SYNC_STATES)[number];

const nameOf = stateNameOf(SYNC_STATES);

/** The sync UI's view model as a pure function of the actor snapshot. `busy`
 * is exactly "an enroll is in flight"; `settled` is "nothing is in flight and
 * the status is known"; a fatal message replaces the context error. */
export function syncViewModel(s: Snapshot<SyncContext>) {
  const state = nameOf(s);
  const fatal = fatalErrorOf(s);
  return {
    status: s.context.status,
    state,
    busy: state === "addingMemberByKey",
    settled:
      state === "showingAlbum" ||
      state === "waitingForAdminApproval" ||
      state === "couldNotAddMember",
    error: fatal?.message ?? s.context.error,
    fatal: fatal !== null,
  };
}

/** Nothing has been checked yet; the album status is unknown. */
const albumNotChecked = state("albumNotChecked")();
/** Checking the current state of the shared album. */
const checkingAlbum = state("checkingAlbum")();
/** The album status is up to date and the person can add an album. */
const showingAlbum = state("showingAlbum")();
/**
 * The person can look at this album's photos but not add any yet: the Admin has to approve
 * them. Only albums joined by their key before invite links reach this; the album shows
 * 'Waiting for approval'.
 */
const waitingForAdminApproval = state("waitingForAdminApproval")();
/** Adding an album of the person's own to share; a spinner shows until it finishes. */
const addingMemberByKey = state("addingMemberByKey")();
/** Adding a member by drive key failed; the album screen shows why and the person can try again. */
const couldNotAddMember = state("couldNotAddMember")();
/** Checking the album failed; the person sees the problem and can try again. */
const couldNotCheckAlbum = state("couldNotCheckAlbum")();

/** The person opens the sharing screen or asks it to reload. */
const refresh = event("REFRESH")();
/** The album status came back. */
const status = event("ALBUM_CHECKED")<{ status: SyncStatus }>();
/** The album status could not be read (no answer, or the app could not reach it). */
const statusFailed = event("ALBUM_CHECK_FAILED")<{ message: string }>();
/** The person chooses an album of their own to share, with a name. */
const enroll = event("ENROLL")<{ key: string; name: string }>();
/** The album is now set up for sharing. */
const enrolled = event("ENROLLED")<{ status: SyncStatus }>();
/** Setting up the album for sharing did not work. */
const enrollFailed = event("ENROLL_FAILED")<{ message: string }>();
/** The person taps Try again after an error. */
const retry = event("RETRY")();
/** Albums reports the status it now shows after switching album. */
export const statusSeen = event("STATUS_SEEN")<{ status: SyncStatus }>();

type SyncContext = {
  status: SyncStatus | null;
  error: string | null;
  pendingEnroll: { key: string; name: string } | null;
};
type SyncPort = Pick<typeof gateway, "status" | "enroll">;

/** Album status and enroll run through `gateway` and the clock is injected, so tests and the flow inspector can drive it. */
export function createSyncActor(options: { clock: Clock; gateway?: SyncPort }) {
  const port = options.gateway ?? gateway;
  return Actor({
    inputs: [refresh, enroll, retry, statusSeen],
    internal: [status, statusFailed, enrolled, enrollFailed],
    outputs: [],
    states: [
      albumNotChecked,
      checkingAlbum,
      showingAlbum,
      waitingForAdminApproval,
      addingMemberByKey,
      couldNotAddMember,
      couldNotCheckAlbum,
    ],
    initial: albumNotChecked,
    clock: options.clock,
    context: {
      status: null,
      error: null,
      pendingEnroll: null,
    } as SyncContext,
    setup: (m) => {
      /** Another machine reports a newer status: it becomes the status shown, in any state. */
      m.onAny({
        event: statusSeen,
        handler: (e, opts) => {
          opts.context.set({ ...opts.context.get(), status: e.payload.status });
          return {};
        },
      });
      /** A newer status says the Admin has not approved the person yet. */
      m.on(showingAlbum, {
        event: statusSeen,
        to: [waitingForAdminApproval],
        handler: (e) =>
          e.payload.status.folder?.pending ? { state: waitingForAdminApproval } : {},
      });
      /** A newer status says the Admin has approved the person. */
      m.on(waitingForAdminApproval, {
        event: statusSeen,
        to: [showingAlbum],
        handler: (e) => (e.payload.status.folder?.pending ? {} : { state: showingAlbum }),
      });
      /** The first check starts and any old error is cleared. */
      m.on(albumNotChecked, {
        event: refresh,
        to: [checkingAlbum],
        handler: (_e, opts) => {
          opts.context.set({ ...opts.context.get(), error: null });
          return { state: checkingAlbum };
        },
      });
      for (const at of [showingAlbum, waitingForAdminApproval, couldNotAddMember]) {
        /** A reload starts and any old error is cleared. */
        m.on(at, {
          event: refresh,
          to: [checkingAlbum],
          handler: (_e, opts) => {
            opts.context.set({ ...opts.context.get(), error: null });
            return { state: checkingAlbum };
          },
        });
        /** Setting up the person's album for sharing starts and any earlier error is cleared. */
        m.on(at, {
          event: enroll,
          to: [addingMemberByKey],
          handler: (e, opts) => {
            opts.context.set({
              ...opts.context.get(),
              error: null,
              pendingEnroll: { key: e.payload.key, name: e.payload.name },
            });
            return { state: addingMemberByKey };
          },
        });
      }
      /** A reload after an error starts and the error message goes away. */
      m.on(couldNotCheckAlbum, {
        event: refresh,
        to: [checkingAlbum],
        handler: (_e, opts) => {
          opts.context.set({ ...opts.context.get(), error: null });
          return { state: checkingAlbum };
        },
      });
      /** Try again after an error: the check starts again and the error message goes away. */
      m.on(couldNotCheckAlbum, {
        event: retry,
        to: [checkingAlbum],
        handler: (_e, opts) => {
          opts.context.set({ ...opts.context.get(), error: null });
          return { state: checkingAlbum };
        },
      });

      /** The album status is fetched; if that fails or returns nothing, the status fails and the person sees an error. */
      m.effect(checkingAlbum, {
        name: "checkingAlbum",
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
      /** The album status is shown and any error is cleared. */
      m.on(checkingAlbum, {
        event: status,
        to: [showingAlbum, waitingForAdminApproval],
        handler: (e, opts) => {
          opts.context.set({
            ...opts.context.get(),
            status: e.payload.status,
            error: null,
            pendingEnroll: null,
          });
          return {
            state: e.payload.status.folder?.pending ? waitingForAdminApproval : showingAlbum,
          };
        },
      });
      /** The check failed: the person sees an error and can try again. */
      m.on(checkingAlbum, {
        event: statusFailed,
        to: [couldNotCheckAlbum],
        handler: (e, opts) => {
          opts.context.set({
            ...opts.context.get(),
            error: e.payload.message,
            pendingEnroll: null,
          });
          return { state: couldNotCheckAlbum };
        },
      });

      /** The album is set up with its key and name; if that fails or returns no status, setting up fails and the person stays on the sharing screen. */
      m.effect(addingMemberByKey, {
        name: "addingMemberByKey",
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
      /** The album is set up and its status is shown. */
      m.on(addingMemberByKey, {
        event: enrolled,
        to: [showingAlbum],
        handler: (e, opts) => {
          opts.context.set({
            ...opts.context.get(),
            error: null,
            status: e.payload.status,
            pendingEnroll: null,
          });
          return { state: showingAlbum };
        },
      });
      /** Setting up failed: the person sees an error and can try again. */
      m.on(addingMemberByKey, {
        event: enrollFailed,
        to: [couldNotAddMember],
        handler: (e, opts) => {
          opts.context.set({
            ...opts.context.get(),
            error: e.payload.message,
            pendingEnroll: null,
          });
          return { state: couldNotAddMember };
        },
      });
    },
  });
}

export type SyncActor = ReturnType<typeof createSyncActor>;

export const syncActor = createSyncActor({ clock: RealClock() });

export const sync = {
  state: () => nameOf(syncActor.snapshot()),
  refresh: () => syncActor.send(refresh.create()),
  enroll: (key: string, name: string) => syncActor.send(enroll.create({ key, name })),
  retry: () => syncActor.send(retry.create()),
  statusSeen: (status: SyncStatus) => syncActor.send(statusSeen.create({ status })),
};
