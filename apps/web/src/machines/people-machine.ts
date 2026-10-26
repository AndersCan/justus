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

const closed = state("closed")();
const open = state("open")();
const removing = state("removing")();

const openSheet = event("OPEN")();
const closeSheet = event("CLOSE")();
const removeMember = event("REMOVE_MEMBER")<{ folderId: string; memberKey: string }>();
const removed = event("REMOVED")();
const removeFailed = event("REMOVE_FAILED")<{ message: string }>();

type PeopleContext = { pending: { folderId: string; memberKey: string } | null };

const peopleActor = new Actor({
  inputs: [openSheet, closeSheet, removeMember],
  internal: [removed, removeFailed],
  outputs: [],
  states: [closed, open, removing],
  initial: closed,
  clock: new RealClock(),
  context: { pending: null } as PeopleContext,
  setup: (m) => {
    m.on(closed, openSheet, () => {
      $peopleError.set(null);
      requests.refresh();
      return { state: open };
    });
    m.on(open, closeSheet, () => ({ state: closed }));
    m.on(open, removeMember, (e, opts) => {
      $peopleError.set(null);
      opts.context.set({ pending: e.payload });
      return { state: removing };
    });
    m.effect(removing, ({ signal, emit, context }) => {
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
    });
    m.on(removing, removed, (_e, opts) => {
      opts.context.set({ pending: null });
      return { state: open };
    });
    m.on(removing, removeFailed, (e, opts) => {
      $peopleError.set(e.payload.message);
      opts.context.set({ pending: null });
      return { state: open };
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
