import { Actor, RealClock, event, state, type Clock, type Snapshot } from "@mantaq/core";
import type { GrantRecord } from "@justus/core";
import { gateway } from "../gateway";
import { fatalErrorOf, runInvoke, stateNameOf } from "./actor-utils";

/**
 * Share surface: the local grant ledger this device serves photos to, plus the
 * once-daily unknown-holder prompt. Same actor pattern as the requests machine.
 * The ledger is local and durable, so every action works offline; the UI only
 * re-reads after acting to reflect the new state.
 */

type GrantActionKind = "grant" | "decline" | "snooze" | "revoke";

const GRANTS_STATES = [
  "shareListNotLoaded",
  "loadingShareList",
  "showingShareList",
  "savingShareChoice",
  "couldNotLoadShareList",
  "couldNotSaveShareChoice",
] as const;
export type GrantsStateName = (typeof GRANTS_STATES)[number];

function dueRecords(records: GrantRecord[], due: string[]): GrantRecord[] {
  const dueSet = new Set(due);
  return records.filter((r) => dueSet.has(r.peerId));
}

/** The list of people this device shares photos with has not been loaded yet. */
const shareListNotLoaded = state("shareListNotLoaded")();
/** Loading who the person shares photos with and who is due a prompt. */
const loadingShareList = state("loadingShareList")();
/** The list of people is shown and the person can grant, decline, snooze or revoke. */
const showingShareList = state("showingShareList")();
/** Saving the person's choice about someone; buttons are disabled meanwhile. */
const savingShareChoice = state("savingShareChoice")();
/** The choice about this person was not saved; the list stays and the person sees why. */
const couldNotSaveShareChoice = state("couldNotSaveShareChoice")();
/** The list could not be loaded; the person sees the problem and can try again. */
const couldNotLoadShareList = state("couldNotLoadShareList")();

/** The person opens the share screen or asks it to reload. */
const refresh = event("REFRESH")();
/** The people list and the people due a prompt came back. */
const loaded = event("SHARE_LIST_LOADED")<{ records: GrantRecord[]; due: string[] }>();
/** The people list could not be loaded. */
const loadFailed = event("LOAD_FAILED")<{ message: string }>();
/** The person lets someone see their photos, declines, snoozes the daily prompt, or stops sharing with someone. */
const act = event("SHARE_CHOICE_MADE")<{ peerId: string; kind: GrantActionKind }>();
/** The choice was saved. */
const acted = event("SHARE_CHOICE_SAVED")();
/** The choice could not be saved. */
const actFailed = event("SHARE_CHOICE_NOT_SAVED")<{ message: string }>();
/** The person taps Try again after an error. */
const retry = event("RETRY")();

type GrantsContext = {
  pendingAct: { peerId: string; kind: GrantActionKind } | null;
  records: GrantRecord[];
  due: string[];
  error: string | null;
};

const initialContext: GrantsContext = { pendingAct: null, records: [], due: [], error: null };

const nameOf = stateNameOf(GRANTS_STATES);

/** The share surface view model as a pure function of the actor snapshot. */
export function grantsViewModel(s: Snapshot<GrantsContext>) {
  const state = nameOf(s);
  const fatal = fatalErrorOf(s);
  return {
    records: s.context.records,
    due: s.context.due,
    dueRecords: dueRecords(s.context.records, s.context.due),
    state,
    acting: state === "savingShareChoice",
    settled: state === "showingShareList" || state === "couldNotSaveShareChoice",
    error: fatal?.message ?? s.context.error,
    fatal: fatal !== null,
  };
}

type GrantsPort = Pick<typeof gateway, "grants">;

/** The clock and the gateway are injected so tests and the flow inspector can drive the machine. */
export function createGrantsActor(options: { clock: Clock; gateway?: GrantsPort }) {
  const { clock, gateway: port = gateway } = options;
  return Actor({
    inputs: [refresh, act, retry],
    internal: [loaded, loadFailed, acted, actFailed],
    outputs: [],
    states: [
      shareListNotLoaded,
      loadingShareList,
      showingShareList,
      savingShareChoice,
      couldNotLoadShareList,
      couldNotSaveShareChoice,
    ],
    initial: shareListNotLoaded,
    clock,
    context: initialContext,
    setup: (m) => {
      /** The first load starts and any old error is cleared. */
      m.on(shareListNotLoaded, {
        event: refresh,
        to: [loadingShareList],
        handler: (_e, opts) => {
          opts.context.set({ ...opts.context.get(), error: null });
          return { state: loadingShareList };
        },
      });
      for (const at of [showingShareList, couldNotSaveShareChoice]) {
        /** A reload starts and any old error is cleared. */
        m.on(at, {
          event: refresh,
          to: [loadingShareList],
          handler: (_e, opts) => {
            opts.context.set({ ...opts.context.get(), error: null });
            return { state: loadingShareList };
          },
        });
        /** The person's choice starts saving and any earlier error is cleared. */
        m.on(at, {
          event: act,
          to: [savingShareChoice],
          handler: (e, opts) => {
            opts.context.set({
              ...opts.context.get(),
              error: null,
              pendingAct: { peerId: e.payload.peerId, kind: e.payload.kind },
            });
            return { state: savingShareChoice };
          },
        });
      }
      /** A reload after an error starts and the error message goes away. */
      m.on(couldNotLoadShareList, {
        event: refresh,
        to: [loadingShareList],
        handler: (_e, opts) => {
          opts.context.set({ ...opts.context.get(), error: null });
          return { state: loadingShareList };
        },
      });
      /** Try again after an error: loading starts again and the error message goes away. */
      m.on(couldNotLoadShareList, {
        event: retry,
        to: [loadingShareList],
        handler: (_e, opts) => {
          opts.context.set({ ...opts.context.get(), error: null });
          return { state: loadingShareList };
        },
      });

      /** The people and the prompts due today are fetched; if that fails, loading fails and the person sees an error. */
      m.effect(loadingShareList, {
        name: "loadingShareList",
        sends: [loaded, loadFailed],
        fn: ({ signal, emit }) => {
          return runInvoke(
            signal,
            () => port.grants.view(),
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
        },
      });
      /** The people and the prompts due today are shown. */
      m.on(loadingShareList, {
        event: loaded,
        to: [showingShareList],
        handler: (e, opts) => {
          opts.context.set({
            ...opts.context.get(),
            records: e.payload.records,
            due: e.payload.due,
            error: null,
          });
          return { state: showingShareList };
        },
      });
      /** Loading failed: the person sees an error and can try again. */
      m.on(loadingShareList, {
        event: loadFailed,
        to: [couldNotLoadShareList],
        handler: (e, opts) => {
          opts.context.set({ ...opts.context.get(), error: e.payload.message });
          return { state: couldNotLoadShareList };
        },
      });

      /** The person's choice (allow, decline, stop sharing or remind me later) is saved; if it cannot be saved, the person sees an error. */
      m.effect(savingShareChoice, {
        name: "savingShareChoice",
        sends: [acted, actFailed],
        fn: ({ signal, emit, context }) => {
          const pending = context.get().pendingAct;
          if (!pending) {
            emit(actFailed.create({ message: "no pending action" }));
            return;
          }
          const work =
            pending.kind === "grant"
              ? () => port.grants.grant(pending.peerId)
              : pending.kind === "decline"
                ? () => port.grants.decline(pending.peerId)
                : pending.kind === "revoke"
                  ? () => port.grants.revoke(pending.peerId)
                  : () => port.grants.snooze();
          return runInvoke(
            signal,
            work,
            () => emit(acted.create()),
            (message) => emit(actFailed.create({ message })),
          );
        },
      });
      /** The choice is saved, so the list reloads to show the new situation. */
      m.on(savingShareChoice, {
        event: acted,
        to: [loadingShareList],
        handler: (_e, opts) => {
          opts.context.set({ ...opts.context.get(), error: null, pendingAct: null });
          return { state: loadingShareList };
        },
      });
      /** Saving failed: the person sees an error and the list stays as it was. */
      m.on(savingShareChoice, {
        event: actFailed,
        to: [couldNotSaveShareChoice],
        handler: (e, opts) => {
          opts.context.set({ ...opts.context.get(), error: e.payload.message, pendingAct: null });
          return { state: couldNotSaveShareChoice };
        },
      });
    },
  });
}

export const grantsActor = createGrantsActor({ clock: RealClock() });

export const grants = {
  state: () => nameOf(grantsActor.snapshot()),
  refresh: () => grantsActor.send(refresh.create()),
  grant: (peerId: string) => grantsActor.send(act.create({ peerId, kind: "grant" })),
  decline: (peerId: string) => grantsActor.send(act.create({ peerId, kind: "decline" })),
  revoke: (peerId: string) => grantsActor.send(act.create({ peerId, kind: "revoke" })),
  snooze: () => grantsActor.send(act.create({ peerId: "", kind: "snooze" })),
  retry: () => grantsActor.send(retry.create()),
};
