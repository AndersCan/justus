import { isTextJSON } from "./records";
import { Actor, event, state } from "@mantaq/core";
import type { Clock } from "@mantaq/core";
import type { Expectations } from "@mantaq/inspect";
import { withPromise } from "@mantaq/sugar";
import { Either } from "@mantaq/utils";

export type PortError = { reason: string };

/** What a member may do: readers only look, members also add photos. */
export type Role = "reader" | "member";

/**
 * One person already in the album, as the Admin's phone sees them: their role, and their phone saying they left.
 * Asking and accepting stay with the requests machine; Remove, Make Viewer and the album-wide order of changes stay in the store.
 */
export type MembershipPort = {
  makeCollaborator(): Promise<Either<PortError, void>>;
  markLeft(): Promise<Either<PortError, void>>;
};

export type MembershipStart = { role: Role; joinedAt: number };

/** Listed as a Viewer. */
const viewerInAlbum = state("viewerInAlbum")<{ joinedAt: number }>();
/** Listed as a Collaborator. */
const collaboratorInAlbum = state("collaboratorInAlbum")<{ joinedAt: number }>();
/** The Admin's "Let them add photos" is being saved. */
const makingCollaborator = state("makingCollaborator")<{ joinedAt: number }>();
/** Their phone said they left: they are being taken off the lists and noted as left. */
const markingAsLeft = state("markingAsLeft")<{ joinedAt: number; role: Role }>();
/** The person left on their own. */
const leftAlbum = state("leftAlbum")();
const left = leftAlbum.final();

/** The Admin lets a Viewer add photos. */
const makeCollaborator = event("makeCollaborator")();
/** The Admin's phone read a left note in their drive, written at `leftAt`. */
const leftNoteRead = event("leftNoteRead")<{
  /** @example 2 */
  leftAt: number;
}>();

/** The Collaborator role was saved. */
const roleSaved = event("roleSaved")();
/** The Collaborator role could not be saved, so the person stays a Viewer. */
const roleSaveFailed = event("roleSaveFailed")<{ reason: string }>();
/** The leaver was taken off the lists and noted as left. */
const leaverMarked = event("leaverMarked")();
/** The leaver could not be taken off the lists, so they stay as they were. */
const leaverMarkFailed = event("leaverMarkFailed")<{ reason: string }>();

type RoleResult = ReturnType<typeof roleSaved.create> | ReturnType<typeof roleSaveFailed.create>;
type MarkResult =
  | ReturnType<typeof leaverMarked.create>
  | ReturnType<typeof leaverMarkFailed.create>;

function isJoinedAt(value: unknown): value is { joinedAt: number } {
  return isTextJSON(value) && typeof value.joinedAt === "number";
}

function isLeaving(value: unknown): value is { joinedAt: number; role: Role } {
  return (
    isJoinedAt(value) && "role" in value && (value.role === "reader" || value.role === "member")
  );
}

function joinedAtOf(payload: unknown) {
  return isJoinedAt(payload) ? payload.joinedAt : 0;
}

const defaultStart: MembershipStart = { role: "reader", joinedAt: 1 };

/** Used when no port is given, as on the flow page: there are no lists, so every save works. */
const previewPort: MembershipPort = {
  makeCollaborator: async () => Either.right(),
  markLeft: async () => Either.right(),
};

/** Everything but `clock` is optional so the flow inspector can build it from a clock alone. */
export function createMembershipActor(options: {
  clock: Clock;
  port?: MembershipPort;
  start?: MembershipStart;
}) {
  const { clock, port = previewPort, start = defaultStart } = options;
  return Actor({
    inputs: [makeCollaborator, leftNoteRead],
    internal: [roleSaved, roleSaveFailed, leaverMarked, leaverMarkFailed],
    outputs: [],
    states: [viewerInAlbum, collaboratorInAlbum, makingCollaborator, markingAsLeft, left],
    initial:
      start.role === "member"
        ? collaboratorInAlbum.create({ joinedAt: start.joinedAt })
        : viewerInAlbum.create({ joinedAt: start.joinedAt }),
    context: {},
    clock,
    setup: (m) => {
      /** The Admin lets a Viewer add photos, so the role is saved next. */
      m.on(viewerInAlbum, {
        event: makeCollaborator,
        to: [makingCollaborator],
        handler: (_e, { actor }) => ({
          state: makingCollaborator.create({ joinedAt: joinedAtOf(actor.snapshot().payload) }),
        }),
      });
      /** The role is saved; if it cannot be, the person stays a Viewer. */
      m.effect(makingCollaborator, {
        name: "saveCollaborator",
        sends: [roleSaved, roleSaveFailed],
        fn: (input) =>
          withPromise({
            promise: Promise.resolve().then(() => port.makeCollaborator()),
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
      /** The role was saved, so the person is a Collaborator. */
      m.on(makingCollaborator, {
        event: roleSaved,
        to: [collaboratorInAlbum],
        handler: (_e, { actor }) => ({
          state: collaboratorInAlbum.create({ joinedAt: joinedAtOf(actor.snapshot().payload) }),
        }),
      });
      /** The role could not be saved, so the person stays a Viewer. */
      m.on(makingCollaborator, {
        event: roleSaveFailed,
        to: [viewerInAlbum],
        handler: (_e, { actor }) => ({
          state: viewerInAlbum.create({ joinedAt: joinedAtOf(actor.snapshot().payload) }),
        }),
      });

      /** A Viewer's left note is newer than their join, so they are taken off the lists; an older note changes nothing. */
      m.on(viewerInAlbum, {
        event: leftNoteRead,
        to: [markingAsLeft],
        handler: (e, { actor }) => {
          const joinedAt = joinedAtOf(actor.snapshot().payload);
          if (e.payload.leftAt <= joinedAt) return {};
          return { state: markingAsLeft.create({ joinedAt, role: "reader" }) };
        },
      });
      /** A Collaborator's left note is newer than their join, so they are taken off the lists; an older note changes nothing. */
      m.on(collaboratorInAlbum, {
        event: leftNoteRead,
        to: [markingAsLeft],
        handler: (e, { actor }) => {
          const joinedAt = joinedAtOf(actor.snapshot().payload);
          if (e.payload.leftAt <= joinedAt) return {};
          return { state: markingAsLeft.create({ joinedAt, role: "member" }) };
        },
      });
      /** They left while the Admin was making them a Collaborator: leaving wins, so they are taken off whichever list holds them. */
      m.on(makingCollaborator, {
        event: leftNoteRead,
        to: [markingAsLeft],
        handler: (e, { actor }) => {
          const joinedAt = joinedAtOf(actor.snapshot().payload);
          if (e.payload.leftAt <= joinedAt) return {};
          return { state: markingAsLeft.create({ joinedAt, role: "reader" }) };
        },
      });
      /** The leaver is taken off the lists and noted as left. */
      m.effect(markingAsLeft, {
        name: "markLeft",
        sends: [leaverMarked, leaverMarkFailed],
        fn: (input) =>
          withPromise({
            promise: Promise.resolve().then(() => port.markLeft()),
            signal: input.signal,
            emit: input.emit,
            events: {
              success: (result) =>
                Either.match<typeof result, MarkResult>(result, {
                  onLeft: (err) => leaverMarkFailed.create({ reason: err.reason }),
                  onRight: () => leaverMarked.create(),
                }),
              error: (cause) => leaverMarkFailed.create({ reason: String(cause) }),
            },
          }),
      });
      /** They are off the lists, so they have left. */
      m.on(markingAsLeft, {
        event: leaverMarked,
        to: [left],
        handler: () => ({ state: left }),
      });
      /** Taking them off failed, so they stay in the album with the role they had. */
      m.on(markingAsLeft, {
        event: leaverMarkFailed,
        to: [viewerInAlbum, collaboratorInAlbum],
        handler: (_e, { actor }) => {
          const { payload } = actor.snapshot();
          if (!isLeaving(payload)) return {};
          return payload.role === "member"
            ? { state: collaboratorInAlbum.create({ joinedAt: payload.joinedAt }) }
            : { state: viewerInAlbum.create({ joinedAt: payload.joinedAt }) };
        },
      });
    },
  });
}

/** What fuzzing must always see: a person who leaves ends as left. */
export const membershipExpectations: Expectations<typeof createMembershipActor> = {
  leftAlbum: { mustSee: [{}] },
};
