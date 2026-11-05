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

/** This person has no request and is not in the album's member list. */
const notMember = state("notMember")();
/** The person asked to join and is waiting for the owner to approve or decline. */
const requestPending = state("requestPending")<RequestEntry>();
/** The owner approved the request and the member list is being written. */
const approved = state("approved")<{ entry: RequestEntry; role: Role }>();
/** The person is in the member list and can see the shared photos. */
const enrolled = state("enrolled")<{ role: Role }>();
/** The owner is changing the member's role and it is being saved. */
const changingRole = state("changingRole")<{ from: Role; to: Role }>();
/** The owner is taking the person out of the member list. */
const removing = state("removing")<{ role: Role }>();
/** The person was removed and cannot rejoin. */
const removedState = state("removed")();
const removed = removedState.final();

/** The person sends a request to join. */
const requestSent = event("requestSent")<RequestEntry>();
/** The owner approves the request and picks the role the person joins with. */
const approve = event("approve")<{ role: Role }>();
/** The owner gives a member a different role. */
const changeRole = event("changeRole")<{ role: Role }>();
/** The owner declines the request. */
const decline = event("decline")();
/** The owner removes a member. */
const remove = event("remove")();

/** The member list was saved with the new member. */
const registryWritten = event("registryWritten")();
/** The member list could not be saved, so the request stays pending. */
const registryWriteFailed = event("registryWriteFailed")<{ reason: string; entry: RequestEntry }>();
/** The new role was saved. */
const roleSaved = event("roleSaved")();
/** The new role could not be saved, so the member keeps the old role. */
const roleSaveFailed = event("roleSaveFailed")<{ reason: string }>();
/** The member was taken out of the member list. */
const memberDropped = event("memberDropped")();
/** The member could not be taken out, so they stay a member. */
const memberDropFailed = event("memberDropFailed")<{ reason: string }>();

/** Tells the rest of the app that the person is now a member. */
const memberEnrolled = event("memberEnrolled")<{ memberKey: string }>();
/** Tells the rest of the app that the person is no longer a member. */
const memberRemoved = event("memberRemoved")<{ memberKey: string }>();

type AddResult =
  | ReturnType<typeof registryWritten.create>
  | ReturnType<typeof registryWriteFailed.create>;
type RoleResult = ReturnType<typeof roleSaved.create> | ReturnType<typeof roleSaveFailed.create>;
type DropResult =
  | ReturnType<typeof memberDropped.create>
  | ReturnType<typeof memberDropFailed.create>;

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
  if (isEnrolled(records.registry, memberKey)) return enrolled.create({ role: "member" });
  const entry = Object.values(records.requests).find((r) => r.requesterKey === memberKey);
  if (entry) return requestPending.create(entry);
  return notMember;
}

const noRecords: MembershipRecords = {
  registry: { version: 1, members: {} },
  removed: { version: 1, removed: {} },
  requests: {},
};

const unavailablePort: MembershipPort = {
  addMember: async () => Either.left({ reason: "no membership port" }),
  setRole: async () => Either.left({ reason: "no membership port" }),
  removeMember: async () => Either.left({ reason: "no membership port" }),
};

/** Everything but `clock` is optional so the flow inspector can build it from a clock alone. */
export function createMembershipActor(options: {
  clock: Clock;
  port?: MembershipPort;
  records?: MembershipRecords;
  memberKey?: string;
}) {
  const { clock, port = unavailablePort, records = noRecords, memberKey = "" } = options;
  return Actor({
    inputs: [requestSent, approve, decline, changeRole, remove],
    internal: [
      registryWritten,
      registryWriteFailed,
      roleSaved,
      roleSaveFailed,
      memberDropped,
      memberDropFailed,
    ],
    outputs: [memberEnrolled, memberRemoved],
    states: [notMember, requestPending, approved, enrolled, changingRole, removing, removed],
    initial: initialStateFromRecords({ records, memberKey }),
    clock,
    setup: (m) => {
      /** A request arrives and waits for the owner's decision. */
      m.on(notMember, {
        event: requestSent,
        to: [requestPending],
        handler: (e) => ({ state: requestPending.create(e.payload) }),
      });
      /** The owner declines, so the person is no longer asking to join. */
      m.on(requestPending, {
        event: decline,
        to: [notMember],
        handler: () => ({ state: notMember }),
      });
      /** The owner approves, so the member list is written next. */
      m.on(requestPending, {
        event: approve,
        to: [approved],
        handler: (e, { actor }) => {
          const { payload } = actor.snapshot();
          return isRequestEntry(payload)
            ? { state: approved.create({ entry: payload, role: e.payload.role }) }
            : {};
        },
      });
      /** The approved person is added to the album's member list; if the list cannot be written, the request fails and the owner can try again. */
      m.effect(approved, {
        name: "addMember",
        sends: [registryWritten, registryWriteFailed],
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
                    registryWriteFailed.create({
                      reason: err.reason,
                      entry: input.state.payload.entry,
                    }),
                  onRight: () => registryWritten.create(),
                }),
              error: (cause) =>
                registryWriteFailed.create({
                  reason: String(cause),
                  entry: input.state.payload.entry,
                }),
            },
          }),
      });
      /** The member list was saved, so the person becomes a member. */
      m.on(approved, {
        event: registryWritten,
        to: [enrolled],
        handler: (_e, { actor }) => {
          const { payload } = actor.snapshot();
          const role = isApproved(payload) ? payload.role : "member";
          return { state: enrolled.create({ role }), emit: [memberEnrolled.create({ memberKey })] };
        },
      });
      /** The member list could not be saved, so the request goes back to waiting. */
      m.on(approved, {
        event: registryWriteFailed,
        to: [requestPending],
        handler: (e) => ({ state: requestPending.create(e.payload.entry) }),
      });
      /** The owner picks a different role, so the new role is saved next. */
      m.on(enrolled, {
        event: changeRole,
        to: [changingRole],
        handler: (e, { actor }) => {
          const { payload } = actor.snapshot();
          const from = isRole(payload) ? payload.role : "member";
          return { state: changingRole.create({ from, to: e.payload.role }) };
        },
      });
      /** The new role is saved; if it cannot be, the member keeps the old role. */
      m.effect(changingRole, {
        name: "setRole",
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
      m.on(changingRole, {
        event: roleSaved,
        to: [enrolled],
        handler: (_e, { actor }) => {
          const { payload } = actor.snapshot();
          return isChange(payload) ? { state: enrolled.create({ role: payload.to }) } : {};
        },
      });
      /** The new role could not be saved, so the member keeps the old role. */
      m.on(changingRole, {
        event: roleSaveFailed,
        to: [enrolled],
        handler: (_e, { actor }) => {
          const { payload } = actor.snapshot();
          return isChange(payload) ? { state: enrolled.create({ role: payload.from }) } : {};
        },
      });
      /** The owner removes the member, so they are taken out of the list next. */
      m.on(enrolled, {
        event: remove,
        to: [removing],
        handler: (_e, { actor }) => {
          const { payload } = actor.snapshot();
          return { state: removing.create({ role: isRole(payload) ? payload.role : "member" }) };
        },
      });
      /** The member is removed from the album's member list; if the list cannot be written, removing fails and the member stays. */
      m.effect(removing, {
        name: "removeMember",
        sends: [memberDropped, memberDropFailed],
        fn: (input) =>
          withPromise({
            promise: Promise.resolve().then(() => port.removeMember(memberKey)),
            signal: input.signal,
            emit: input.emit,
            events: {
              success: (result) =>
                Either.match<typeof result, DropResult>(result, {
                  onLeft: (err) => memberDropFailed.create({ reason: err.reason }),
                  onRight: () => memberDropped.create(),
                }),
              error: (cause) => memberDropFailed.create({ reason: String(cause) }),
            },
          }),
      });
      /** The member was taken out, so they are now removed. */
      m.on(removing, {
        event: memberDropped,
        to: [removed],
        handler: () => ({ state: removed, emit: [memberRemoved.create({ memberKey })] }),
      });
      /** Taking the member out failed, so they stay a member. */
      m.on(removing, {
        event: memberDropFailed,
        to: [enrolled],
        handler: (_e, { actor }) => {
          const { payload } = actor.snapshot();
          return { state: enrolled.create({ role: isRole(payload) ? payload.role : "member" }) };
        },
      });
    },
  });
}
