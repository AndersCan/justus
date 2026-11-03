import type { RegistryFile, RemovedFile, RequestsFile } from "./records";
import { isEnrolled, isTextJSON } from "./records";
import { Actor, event, state } from "@mantaq/core";
import type { Clock } from "@mantaq/core";
import { withPromise } from "@mantaq/sugar";
import { Either } from "@mantaq/utils";

export type RequestEntry = RequestsFile["requests"][string];

export type PortError = { reason: string };

/** `Either.right` needs a non-nullish value, so a successful write carries `{}`. */
export type Done = Record<string, never>;

export type MembershipPort = {
  addMember(entry: RequestEntry): Promise<Either<PortError, Done>>;
  removeMember(memberKey: string): Promise<Either<PortError, Done>>;
};

export type MembershipRecords = {
  registry: RegistryFile;
  removed: RemovedFile;
  requests: RequestsFile["requests"];
};

const notMember = state("notMember")();
const requestPending = state("requestPending")<RequestEntry>();
const approved = state("approved")<RequestEntry>();
const enrolled = state("enrolled")();
const removing = state("removing")();
const removed = state("removed")().final();

const requestSent = event("requestSent")<RequestEntry>();
const approve = event("approve")();
const decline = event("decline")();
const remove = event("remove")();

const registryWritten = event("registryWritten")();
const registryWriteFailed = event("registryWriteFailed")<{ reason: string; entry: RequestEntry }>();
const memberDropped = event("memberDropped")();
const memberDropFailed = event("memberDropFailed")<{ reason: string }>();

const memberEnrolled = event("memberEnrolled")<{ memberKey: string }>();
const memberRemoved = event("memberRemoved")<{ memberKey: string }>();

type AddResult =
  | ReturnType<typeof registryWritten.create>
  | ReturnType<typeof registryWriteFailed.create>;
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

export function initialStateFromRecords(options: {
  records: MembershipRecords;
  memberKey: string;
}) {
  const { records, memberKey } = options;
  if (Object.values(records.removed.removed).some((r) => r.memberKey === memberKey)) {
    return removed;
  }
  if (isEnrolled(records.registry, memberKey)) return enrolled;
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
    inputs: [requestSent, approve, decline, remove],
    internal: [registryWritten, registryWriteFailed, memberDropped, memberDropFailed],
    outputs: [memberEnrolled, memberRemoved],
    states: [notMember, requestPending, approved, enrolled, removing, removed],
    initial: initialStateFromRecords({ records, memberKey }),
    clock,
    setup: (m) => {
      m.on(notMember, {
        event: requestSent,
        to: [requestPending],
        handler: (e) => ({ state: requestPending.create(e.payload) }),
      });
      m.on(requestPending, {
        event: decline,
        to: [notMember],
        handler: () => ({ state: notMember }),
      });
      m.on(requestPending, {
        event: approve,
        to: [approved],
        handler: (_e, { actor }) => {
          const { payload } = actor.snapshot();
          return isRequestEntry(payload) ? { state: approved.create(payload) } : {};
        },
      });
      m.effect(approved, {
        name: "addMember",
        sends: [registryWritten, registryWriteFailed],
        fn: (input) =>
          withPromise({
            promise: Promise.resolve().then(() => port.addMember(input.state.payload)),
            signal: input.signal,
            emit: input.emit,
            events: {
              success: (result) =>
                Either.match<typeof result, AddResult>(result, {
                  onLeft: (err) =>
                    registryWriteFailed.create({ reason: err.reason, entry: input.state.payload }),
                  onRight: () => registryWritten.create(),
                }),
              error: (cause) =>
                registryWriteFailed.create({ reason: String(cause), entry: input.state.payload }),
            },
          }),
      });
      m.on(approved, {
        event: registryWritten,
        to: [enrolled],
        handler: () => ({ state: enrolled, emit: [memberEnrolled.create({ memberKey })] }),
      });
      m.on(approved, {
        event: registryWriteFailed,
        to: [requestPending],
        handler: (e) => ({ state: requestPending.create(e.payload.entry) }),
      });
      m.on(enrolled, {
        event: remove,
        to: [removing],
        handler: () => ({ state: removing }),
      });
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
      m.on(removing, {
        event: memberDropped,
        to: [removed],
        handler: () => ({ state: removed, emit: [memberRemoved.create({ memberKey })] }),
      });
      m.on(removing, {
        event: memberDropFailed,
        to: [enrolled],
        handler: () => ({ state: enrolled }),
      });
    },
  });
}
