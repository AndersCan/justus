import type { RegistryFile, RemovedFile, RequestsFile } from "./records";
import { isEnrolled, isTextJSON } from "./records";
import { Actor, event, state } from "@mantaq/core";
import type { Clock } from "@mantaq/core";
import type { Expectations } from "@mantaq/inspect";
import { withPromise } from "@mantaq/sugar";
import { Either } from "@mantaq/utils";

export type RequestEntry = RequestsFile["requests"][string];

export type PortError = { reason: string };

/** What a member may do: readers only look, members also add photos. */
export type Role = "reader" | "member";

export type MembershipPort = {
  addMember(entry: RequestEntry, role: Role): Promise<Either<PortError, void>>;
  setRole(memberKey: string, role: Role): Promise<Either<PortError, void>>;
  removeMember(memberKey: string): Promise<Either<PortError, void>>;
};

export type MembershipRecords = {
  registry: RegistryFile;
  removed: RemovedFile;
  requests: RequestsFile["requests"];
};

/** This person has not asked to join and is not in the member list. */
const noRequestYet = state("noRequestYet")();
/** The person asked to join and waits for the Admin to accept or decline. */
const requestWaitingForAdmin = state("requestWaitingForAdmin")<RequestEntry>();
/** The Admin accepted, and the member list is being saved. */
const addingMember = state("addingMember")<{ entry: RequestEntry; role: Role }>();
/** The person is in the member list with their role. */
const memberOfAlbum = state("memberOfAlbum")<{ role: Role }>();
/** The Admin picked a different role, and it is being saved. */
const savingRole = state("savingRole")<{ from: Role; to: Role }>();
/** The Admin is taking the person out of the member list. */
const removingMember = state("removingMember")<{ role: Role }>();
/** The Admin declined the request; a new request starts again. */
const requestDeclined = state("requestDeclined")();
/** The person was removed and cannot rejoin. */
const removedFromAlbum = state("removedFromAlbum")();
const removed = removedFromAlbum.final();

/** The person's request to join reached the Admin. */
const requestQueued = event("requestQueued")<RequestEntry>();
/** The Admin accepts the request with the role the person joins with. */
const accept = event("accept")<{ role: Role }>();
/** The Admin gives a member a different role. */
const changeRole = event("changeRole")<{ role: Role }>();
/** The Admin declines the request. */
const decline = event("decline")();
/** The Admin removes a member. */
const removeMember = event("removeMember")();

/** The member list was saved with the new member. */
const memberListSaved = event("memberListSaved")();
/** The member list could not be saved, so the request stays pending. */
const memberListSaveFailed = event("memberListSaveFailed")<{
  reason: string;
  entry: RequestEntry;
}>();
/** The new role was saved. */
const roleSaved = event("roleSaved")();
/** The new role could not be saved, so the member keeps the old role. */
const roleSaveFailed = event("roleSaveFailed")<{ reason: string }>();
/** The member was taken out of the member list. */
const removalSaved = event("removalSaved")();
/** The member could not be taken out, so they stay a member. */
const removalFailed = event("removalFailed")<{ reason: string }>();

/** Tells the rest of the app that the person is now a member. */
const memberJoined = event("memberJoined")<{ memberKey: string }>();
/** Tells the joiner's side that the Admin accepted or declined. */
const requestAnswered = event("requestAnswered")<{ answer: "accepted" | "declined" }>();
/** Tells the rest of the app that the person is no longer a member. */
const memberRemoved = event("memberRemoved")<{ memberKey: string }>();

type AddResult =
  | ReturnType<typeof memberListSaved.create>
  | ReturnType<typeof memberListSaveFailed.create>;
type RoleResult = ReturnType<typeof roleSaved.create> | ReturnType<typeof roleSaveFailed.create>;
type DropResult = ReturnType<typeof removalSaved.create> | ReturnType<typeof removalFailed.create>;

function isRequestEntry(value: unknown): value is RequestEntry {
  return (
    isTextJSON(value) &&
    typeof value.requesterKey === "string" &&
    typeof value.requesterName === "string" &&
    typeof value.shareKey === "string" &&
    typeof value.folderName === "string" &&
    typeof value.requestedAt === "number"
  );
}

function isRoleName(value: unknown): value is Role {
  return value === "reader" || value === "member";
}

function isRole(value: unknown): value is { role: Role } {
  return isTextJSON(value) && isRoleName(value.role);
}

function isApproved(value: unknown): value is { entry: RequestEntry; role: Role } {
  return isTextJSON(value) && isRoleName(value.role) && isRequestEntry(value.entry);
}

function isChange(value: unknown): value is { from: Role; to: Role } {
  return isTextJSON(value) && isRoleName(value.from) && isRoleName(value.to);
}

export function initialStateFromRecords(options: {
  records: MembershipRecords;
  memberKey: string;
}) {
  const { records, memberKey } = options;
  if (Object.values(records.removed.removed).some((r) => r.memberKey === memberKey)) {
    return removed;
  }
  if (isEnrolled(records.registry, memberKey)) return memberOfAlbum.create({ role: "member" });
  const entry = Object.values(records.requests).find((r) => r.requesterKey === memberKey);
  if (entry) return requestWaitingForAdmin.create(entry);
  return noRequestYet;
}

const noRecords: MembershipRecords = {
  registry: { version: 1, members: {} },
  removed: { version: 1, removed: {} },
  requests: {},
};

/** Used when no port is given, as on the flow page: there is no member list, so every save works. */
const previewPort: MembershipPort = {
  addMember: async () => Either.right(),
  setRole: async () => Either.right(),
  removeMember: async () => Either.right(),
};

/** Everything but `clock` is optional so the flow inspector can build it from a clock alone. */
export function createMembershipActor(options: {
  clock: Clock;
  port?: MembershipPort;
  records?: MembershipRecords;
  memberKey?: string;
}) {
  const { clock, port = previewPort, records = noRecords, memberKey = "" } = options;
  return Actor({
    inputs: [requestQueued, accept, decline, changeRole, removeMember],
    internal: [
      memberListSaved,
      memberListSaveFailed,
      roleSaved,
      roleSaveFailed,
      removalSaved,
      removalFailed,
    ],
    outputs: [memberJoined, memberRemoved, requestAnswered],
    states: [
      noRequestYet,
      requestWaitingForAdmin,
      addingMember,
      memberOfAlbum,
      savingRole,
      removingMember,
      requestDeclined,
      removed,
    ],
    initial: initialStateFromRecords({ records, memberKey }),
    /** Whether the Admin accepted this person; an enrolled member starts accepted. */
    context: { accepted: isEnrolled(records.registry, memberKey) },
    clock,
    setup: (m) => {
      /** A request arrives and waits for the Admin's decision. */
      m.on(noRequestYet, {
        event: requestQueued,
        to: [requestWaitingForAdmin],
        handler: (e, { context }) => {
          context.set({ accepted: false });
          return { state: requestWaitingForAdmin.create(e.payload) };
        },
      });
      /** The Admin declines, so the request ends. */
      m.on(requestWaitingForAdmin, {
        event: decline,
        to: [requestDeclined],
        handler: () => ({
          state: requestDeclined,
          emit: [requestAnswered.create({ answer: "declined" })],
        }),
      });
      /** After a decline, a new request waits for the Admin to decide again. */
      m.on(requestDeclined, {
        event: requestQueued,
        to: [requestWaitingForAdmin],
        handler: (e, { context }) => {
          context.set({ accepted: false });
          return { state: requestWaitingForAdmin.create(e.payload) };
        },
      });
      /** The Admin approves, so the member list is written next. */
      m.on(requestWaitingForAdmin, {
        event: accept,
        to: [addingMember],
        handler: (e, { actor, context }) => {
          const { payload } = actor.snapshot();
          if (!isRequestEntry(payload)) return {};
          context.set({ accepted: true });
          return { state: addingMember.create({ entry: payload, role: e.payload.role }) };
        },
      });
      /** The accepted person is added to the album's member list; if the list cannot be written, the request fails and the Admin can try again. */
      m.effect(addingMember, {
        name: "saveNewMember",
        sends: [memberListSaved, memberListSaveFailed],
        fn: (input) =>
          withPromise({
            promise: Promise.resolve().then(() =>
              port.addMember(input.state.payload.entry, input.state.payload.role),
            ),
            signal: input.signal,
            emit: input.emit,
            events: {
              success: (result) =>
                Either.match<typeof result, AddResult>(result, {
                  onLeft: (err) =>
                    memberListSaveFailed.create({
                      reason: err.reason,
                      entry: input.state.payload.entry,
                    }),
                  onRight: () => memberListSaved.create(),
                }),
              error: (cause) =>
                memberListSaveFailed.create({
                  reason: String(cause),
                  entry: input.state.payload.entry,
                }),
            },
          }),
      });
      /** The member list was saved, so the person becomes a member. */
      m.on(addingMember, {
        event: memberListSaved,
        to: [memberOfAlbum],
        handler: (_e, { actor }) => {
          const { payload } = actor.snapshot();
          const role = isApproved(payload) ? payload.role : "member";
          return {
            state: memberOfAlbum.create({ role }),
            emit: [
              memberJoined.create({ memberKey }),
              requestAnswered.create({ answer: "accepted" }),
            ],
          };
        },
      });
      /** The member list could not be saved, so the request goes back to waiting. */
      m.on(addingMember, {
        event: memberListSaveFailed,
        to: [requestWaitingForAdmin],
        handler: (e, { context }) => {
          context.set({ accepted: false });
          return { state: requestWaitingForAdmin.create(e.payload.entry) };
        },
      });
      /** The Admin picks a different role, so the new role is saved next. */
      m.on(memberOfAlbum, {
        event: changeRole,
        to: [savingRole],
        handler: (e, { actor }) => {
          const { payload } = actor.snapshot();
          const from = isRole(payload) ? payload.role : "member";
          return { state: savingRole.create({ from, to: e.payload.role }) };
        },
      });
      /** The new role is saved; if it cannot be, the member keeps the old role. */
      m.effect(savingRole, {
        name: "saveRole",
        sends: [roleSaved, roleSaveFailed],
        fn: (input) =>
          withPromise({
            promise: Promise.resolve().then(() => port.setRole(memberKey, input.state.payload.to)),
            signal: input.signal,
            emit: input.emit,
            events: {
              success: (result) =>
                Either.match<typeof result, RoleResult>(result, {
                  onLeft: (err) => roleSaveFailed.create({ reason: err.reason }),
                  onRight: () => roleSaved.create(),
                }),
              error: (cause) => roleSaveFailed.create({ reason: String(cause) }),
            },
          }),
      });
      /** The new role was saved, so the member has it. */
      m.on(savingRole, {
        event: roleSaved,
        to: [memberOfAlbum],
        handler: (_e, { actor }) => {
          const { payload } = actor.snapshot();
          return isChange(payload) ? { state: memberOfAlbum.create({ role: payload.to }) } : {};
        },
      });
      /** The new role could not be saved, so the member keeps the old role. */
      m.on(savingRole, {
        event: roleSaveFailed,
        to: [memberOfAlbum],
        handler: (_e, { actor }) => {
          const { payload } = actor.snapshot();
          return isChange(payload) ? { state: memberOfAlbum.create({ role: payload.from }) } : {};
        },
      });
      /** The Admin removes the member, so they are taken out of the list next. */
      m.on(memberOfAlbum, {
        event: removeMember,
        to: [removingMember],
        handler: (_e, { actor }) => {
          const { payload } = actor.snapshot();
          return {
            state: removingMember.create({ role: isRole(payload) ? payload.role : "member" }),
          };
        },
      });
      /** The member is removed from the album's member list; if the list cannot be written, removing fails and the member stays. */
      m.effect(removingMember, {
        name: "saveRemoval",
        sends: [removalSaved, removalFailed],
        fn: (input) =>
          withPromise({
            promise: Promise.resolve().then(() => port.removeMember(memberKey)),
            signal: input.signal,
            emit: input.emit,
            events: {
              success: (result) =>
                Either.match<typeof result, DropResult>(result, {
                  onLeft: (err) => removalFailed.create({ reason: err.reason }),
                  onRight: () => removalSaved.create(),
                }),
              error: (cause) => removalFailed.create({ reason: String(cause) }),
            },
          }),
      });
      /** The member was taken out, so they are now removed. */
      m.on(removingMember, {
        event: removalSaved,
        to: [removed],
        handler: () => ({ state: removed, emit: [memberRemoved.create({ memberKey })] }),
      });
      /** Taking the member out failed, so they stay a member. */
      m.on(removingMember, {
        event: removalFailed,
        to: [memberOfAlbum],
        handler: (_e, { actor }) => {
          const { payload } = actor.snapshot();
          return {
            state: memberOfAlbum.create({ role: isRole(payload) ? payload.role : "member" }),
          };
        },
      });
    },
  });
}

/** What fuzzing must never and must always see: nobody is added without the Admin's accept, and an accepted request still becomes a member. */
export const membershipExpectations: Expectations<typeof createMembershipActor> = {
  addingMember: { neverSee: [{ accepted: false }] },
  memberOfAlbum: { neverSee: [{ accepted: false }], mustSee: [{ accepted: true }] },
};
