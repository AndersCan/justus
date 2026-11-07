import { Actor, RealClock, event, state, type Clock, type Snapshot } from "@mantaq/core";
import { onOutput } from "@mantaq/sugar";
import { atom, computed } from "nanostores";
import { gateway } from "../gateway";
import { buildPeople } from "../utils/people";
import { $friends } from "./friends-machine";
import { bindStateAtoms, fatalErrorOf, runInvoke, stateNameOf } from "./actor-utils";
import { $requests, requests } from "./requests-machine";
import { $syncStatus } from "./sync-machine";
import type { JoinRequest, SyncStatus } from "@justus/core";

/**
 * The People sheet: opened from the header chip, closed again, and the
 * Admin's Remove action. The members themselves come from the sync status;
 * pending requests from the requests machine.
 */

const PEOPLE_STATES = ["closed", "open", "removing"] as const;
export type PeopleStateName = (typeof PEOPLE_STATES)[number];

export const $peopleState = atom<PeopleStateName>("closed");
export const $peopleError = atom<string | null>(null);
export const $peopleFatal = atom(false);

export const $peopleViewModel = computed(
  [$syncStatus, $requests, $peopleState, $peopleError, $friends],
  (status, reqs, state, error, friendNames) => ({
    ...buildPeople(status, reqs, friendNames),
    open: state !== "closed",
    removing: state === "removing",
    error,
    isAdmin: status?.folder.role === "creator",
    folder: status?.folder ?? null,
    myName: status?.name ?? "",
  }),
);

/** The People sheet is hidden. */
const closed = state("closed")();
/** The People sheet is showing the album's members and anyone waiting to join. */
const open = state("open")();
/** The Admin has asked to remove someone and the sheet waits for that to finish. */
const removing = state("removing")();

/** The person taps the people chip to see who is in the album. */
const openSheet = event("OPEN")();
/** The person closes the People sheet. */
const closeSheet = event("CLOSE")();
/** The Admin chooses to remove a member from the album. */
const removeMember = event("REMOVE_MEMBER")<{ folderId: string; memberKey: string }>();
/** The member was taken out of the album. */
const removed = event("REMOVED")();
/** The member could not be removed. */
const removeFailed = event("REMOVE_FAILED")<{ message: string }>();

/** The sheet was just opened, so the latest join requests are worth fetching. */
const sheetOpened = event("SHEET_OPENED")();

type PeopleContext = {
  pending: { folderId: string; memberKey: string } | null;
  error: string | null;
};
const nameOf = stateNameOf(PEOPLE_STATES);

/** The People sheet view model as a pure function of the actor snapshot and
 * the values other machines own: the sync status, the join requests and the
 * saved friend names. */
export function peopleViewModel(
  s: Snapshot<PeopleContext>,
  deps: { status: SyncStatus | null; requests: JoinRequest[]; friends: Record<string, string> },
) {
  const state = nameOf(s);
  return {
    ...buildPeople(deps.status, deps.requests, deps.friends),
    open: state !== "closed",
    removing: state === "removing",
    error: fatalErrorOf(s)?.message ?? s.context.error,
    isAdmin: deps.status?.folder.role === "creator",
    folder: deps.status?.folder ?? null,
    myName: deps.status?.name ?? "",
  };
}

type PeoplePort = Pick<typeof gateway, "removeMember">;

/** The Admin's removal runs through `gateway` and the clock is injected, so tests and the flow inspector can drive it. */
export function createPeopleActor(options: { clock: Clock; gateway?: PeoplePort }) {
  const port = options.gateway ?? gateway;
  return Actor({
    inputs: [openSheet, closeSheet, removeMember],
    internal: [removed, removeFailed],
    outputs: [sheetOpened],
    states: [closed, open, removing],
    initial: closed,
    clock: options.clock,
    context: { pending: null, error: null } as PeopleContext,
    setup: (m) => {
      /** Opening the sheet clears any old error and asks for the latest join requests. */
      m.on(closed, {
        event: openSheet,
        to: [open],
        handler: (_e, opts) => {
          opts.context.set({ pending: null, error: null });
          return { state: open, emit: [sheetOpened.create()] };
        },
      });
      /** Closing the sheet hides it again. */
      m.on(open, { event: closeSheet, to: [closed], handler: () => ({ state: closed }) });
      /** The Admin picks a member to remove; the sheet shows that it is working. */
      m.on(open, {
        event: removeMember,
        to: [removing],
        handler: (e, opts) => {
          opts.context.set({ pending: e.payload, error: null });
          return { state: removing };
        },
      });
      /** The member is taken out of the album. */
      m.effect(removing, {
        name: "removing",
        sends: [removed, removeFailed],
        fn: ({ signal, emit, context }) => {
          const pending = context.get().pending;
          if (!pending) {
            emit(removeFailed.create({ message: "no member to remove" }));
            return;
          }
          return runInvoke(
            signal,
            () => port.removeMember(pending.folderId, pending.memberKey),
            () => emit(removed.create()),
            (message) => emit(removeFailed.create({ message })),
          );
        },
      });
      /** The member is gone and the sheet shows the updated list. */
      m.on(removing, {
        event: removed,
        to: [open],
        handler: (_e, opts) => {
          opts.context.set({ pending: null, error: null });
          return { state: open };
        },
      });
      /** Removing failed: the sheet stays open and tells the person what went wrong, and the member stays in the album. */
      m.on(removing, {
        event: removeFailed,
        to: [open],
        handler: (e, opts) => {
          opts.context.set({ pending: null, error: e.payload.message });
          return { state: open };
        },
      });
    },
  });
}

export const peopleActor = createPeopleActor({ clock: RealClock() });

peopleActor.on("change", {
  fn: (snapshot) => {
    $peopleError.set(snapshot.context.error);
  },
});

onOutput(peopleActor, () => requests.refresh());

bindStateAtoms({
  actor: peopleActor,
  states: PEOPLE_STATES,
  $state: $peopleState,
  $error: $peopleError,
  $fatal: $peopleFatal,
});

export const people = {
  open: () => peopleActor.send(openSheet.create()),
  close: () => peopleActor.send(closeSheet.create()),
  remove: (folderId: string, memberKey: string) =>
    peopleActor.send(removeMember.create({ folderId, memberKey })),
};
