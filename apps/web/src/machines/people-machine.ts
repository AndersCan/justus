import { Actor, RealClock, event, state } from "@mantaq/core";
import { atom, computed } from "nanostores";
import { gateway } from "../gateway";
import { buildPeople } from "../utils/people";
import { bindStateAtoms, runInvoke } from "./actor-utils";
import { $requests, requests } from "./requests-machine";
import { $syncStatus } from "./sync-machine";

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
  [$syncStatus, $requests, $peopleState, $peopleError],
  (status, reqs, state, error) => ({
    ...buildPeople(status, reqs),
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

type PeopleContext = { pending: { folderId: string; memberKey: string } | null };

export const peopleActor = Actor({
  inputs: [openSheet, closeSheet, removeMember],
  internal: [removed, removeFailed],
  outputs: [],
  states: [closed, open, removing],
  initial: closed,
  clock: RealClock(),
  context: { pending: null } as PeopleContext,
  setup: (m) => {
    /** Opening the sheet clears any old error and asks for the latest join requests. */
    m.on(closed, {
      event: openSheet,
      to: [open],
      handler: () => {
        $peopleError.set(null);
        requests.refresh();
        return { state: open };
      },
    });
    /** Closing the sheet hides it again. */
    m.on(open, { event: closeSheet, to: [closed], handler: () => ({ state: closed }) });
    /** The Admin picks a member to remove; the sheet shows that it is working. */
    m.on(open, {
      event: removeMember,
      to: [removing],
      handler: (e, opts) => {
        $peopleError.set(null);
        opts.context.set({ pending: e.payload });
        return { state: removing };
      },
    });
    /** The member is taken out of the album. */
    m.effect(removing, {
      name: "removing",
      fn: ({ signal, emit, context }) => {
        const pending = context.get().pending;
        if (!pending) {
          emit(removeFailed.create({ message: "no member to remove" }));
          return;
        }
        return runInvoke(
          signal,
          () => gateway.removeMember(pending.folderId, pending.memberKey),
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
        opts.context.set({ pending: null });
        return { state: open };
      },
    });
    /** Removing failed: the sheet stays open and tells the person what went wrong, and the member stays in the album. */
    m.on(removing, {
      event: removeFailed,
      to: [open],
      handler: (e, opts) => {
        $peopleError.set(e.payload.message);
        opts.context.set({ pending: null });
        return { state: open };
      },
    });
  },
});

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
