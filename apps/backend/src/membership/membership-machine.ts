import type { RegistryFile, RemovedFile, RequestsFile } from "./records";
import { isEnrolled, isTextJSON } from "./records";
import { Actor, event, state } from "@mantaq/core";
import type { Clock } from "@mantaq/core";
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
const noRequest = state("noRequest")();
/** The person asked to join and waits for the Admin to accept or decline. */
const awaitingDecision = state("awaitingDecision")<RequestEntry>();
/** The Admin accepted, and the member list is being saved. */
const addingMember = state("addingMember")<{ entry: RequestEntry; role: Role }>();
/** The person is in the member list with their role. */
const joined = state("joined")<{ role: Role }>();
/** The Admin picked a different role, and it is being saved. */
const savingRole = state("savingRole")<{ from: Role; to: Role }>();
/** The Admin is taking the person out of the member list. */
const removingMember = state("removingMember")<{ role: Role }>();
/** The Admin declined the request; a new request starts again. */
const declined = state("declined")();
/** The person was removed and cannot rejoin. */
const removedState = state("removed")();
const removed = removedState.final();

/** The person's request to join reached the Admin. */
const requestArrived = event("requestArrived")<RequestEntry>();
/** The Admin accepts the request with the role the person joins with. */
const accept = event("accept")<{ role: Role }>();
/** The owner gives a member a different role. */
const changeRole = event("changeRole")<{ role: Role }>();
/** The owner declines the request. */
const decline = event("decline")();
/** The owner removes a member. */
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
  if (isEnrolled(records.registry, memberKey)) return joined.create({ role: "member" });
  const entry = Object.values(records.requests).find((r) => r.requesterKey === memberKey);
  if (entry) return awaitingDecision.create(entry);
  return noRequest;
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
    inputs: [requestArrived, accept, decline, changeRole, removeMember],
    internal: [
      memberListSaved,
      memberListSaveFailed,
      roleSaved,
      roleSaveFailed,
      removalSaved,
      removalFailed,
    ],
    outputs: [memberJoined, memberRemoved],
    states: [
      noRequest,
      awaitingDecision,
      addingMember,
      joined,
      savingRole,
      removingMember,
      declined,
      removed,
    ],
    initial: initialStateFromRecords({ records, memberKey }),
    clock,
    setup: (m) => {
      /** A request arrives and waits for the owner's decision. */
      m.on(noRequest, {
        event: requestArrived,
        to: [awaitingDecision],
        handler: (e) => ({ state: awaitingDecision.create(e.payload) }),
      });
      /** The Admin declines, so the request ends. */
      m.on(awaitingDecision, {
        event: decline,
        to: [declined],
        handler: () => ({ state: declined }),
      });
      /** After a decline, a new request waits for the Admin to decide again. */
      m.on(declined, {
        event: requestArrived,
        to: [awaitingDecision],
        handler: (e) => ({ state: awaitingDecision.create(e.payload) }),
      });
      /** The owner approves, so the member list is written next. */
      m.on(awaitingDecision, {
        event: accept,
        to: [addingMember],
        handler: (e, { actor }) => {
          const { payload } = actor.snapshot();
          return isRequestEntry(payload)
            ? { state: addingMember.create({ entry: payload, role: e.payload.role }) }
            : {};
        },
      });
      /** The accepted person is added to the album's member list; if the list cannot be written, the request fails and the owner can try again. */
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
        to: [joined],
        handler: (_e, { actor }) => {
          const { payload } = actor.snapshot();
          const role = isApproved(payload) ? payload.role : "member";
          return { state: joined.create({ role }), emit: [memberJoined.create({ memberKey })] };
        },
      });
      /** The member list could not be saved, so the request goes back to waiting. */
      m.on(addingMember, {
        event: memberListSaveFailed,
        to: [awaitingDecision],
        handler: (e) => ({ state: awaitingDecision.create(e.payload.entry) }),
      });
      /** The owner picks a different role, so the new role is saved next. */
      m.on(joined, {
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
        to: [joined],
        handler: (_e, { actor }) => {
          const { payload } = actor.snapshot();
          return isChange(payload) ? { state: joined.create({ role: payload.to }) } : {};
        },
      });
      /** The new role could not be saved, so the member keeps the old role. */
      m.on(savingRole, {
        event: roleSaveFailed,
        to: [joined],
        handler: (_e, { actor }) => {
          const { payload } = actor.snapshot();
          return isChange(payload) ? { state: joined.create({ role: payload.from }) } : {};
        },
      });
      /** The owner removes the member, so they are taken out of the list next. */
      m.on(joined, {
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
        to: [joined],
        handler: (_e, { actor }) => {
          const { payload } = actor.snapshot();
          return { state: joined.create({ role: isRole(payload) ? payload.role : "member" }) };
        },
      });
    },
  });
}
