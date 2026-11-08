import { Actor, event, state } from "@mantaq/core";
import type { Clock } from "@mantaq/core";
import type { Expectations } from "@mantaq/inspect";
import { withPromise } from "@mantaq/sugar";
import { Either } from "@mantaq/utils";

/** Admin ("creator"), Member ("member") or Viewer ("reader"). */
export type Role = "creator" | "member" | "reader";

export type PortError = { reason: string };

/** What removeCopy leaves on this phone. */
export type Keep = "nothing" | "leftNote" | "deleteNote";

export type AlbumLifecyclePort = {
  /** Member or listed Viewer: writes `/left.json` into this phone's own drive in the album. */
  writeLeftNote(): Promise<Either<PortError, void>>;
  /** Admin: writes `/deleted.json` into the album's own drive. */
  writeDeleteNote(): Promise<Either<PortError, void>>;
  /** Removes this phone's photos and copies of the album, except what `keep` names. Never rejects; a drive it cannot remove is logged. Safe to run twice. */
  removeCopy(keep: Keep): Promise<void>;
  /** Whether the Admin's lists name this phone, so a leave must be told: always for a Member, for a Viewer when `/viewers.json` lists them. */
  adminListsYou(): Promise<boolean>;
  /** Removes what `removeCopy("leftNote")` kept. Never rejects. Safe to run twice. */
  forget(): Promise<void>;
};

export type LifecycleStart =
  | {
      state:
        | "shownInYourAlbums"
        | "archived"
        | "leavingAlbum"
        | "waitingForAdminToSeeYouLeft"
        | "deletingForEveryone";
      role: Role;
    }
  | { state: "removingDeletedAlbum"; role: Role; adminName: string };

type LifecycleContext = { role: Role; error: string | null };

/** The album is in Your albums, the Photos tiles and the timeline. */
const shownInYourAlbums = state("shownInYourAlbums")();
/** The album only shows under Archived; it keeps syncing. */
const archived = state("archived")();
/** Leave was confirmed: a Member or a listed Viewer writes "left" into their own drive, then this phone's copy of the album is removed. */
const leavingAlbum = state("leavingAlbum")();
/** Gone from this phone; this phone's own drive keeps telling the Admin "left" until the Admin's member list drops it. */
const waitingForAdminToSeeYouLeft = state("waitingForAdminToSeeYouLeft")();
/** The Admin saw the leave (or deleted the album): the drives kept for telling the Admin are removed. */
const removingYourLastCopy = state("removingYourLastCopy")();
/** Nothing of the album is on this phone. */
const leftAlbum = state("leftAlbum")().final();
/** The Admin confirmed delete: the delete note is written into the album, then this phone's copy is removed. */
const deletingForEveryone = state("deletingForEveryone")();
/** The Admin's phone keeps only the delete note and offers it to members who were away. */
const deletedForEveryone = state("deletedForEveryone")().final();
/** This phone heard that the Admin deleted the album and is removing its copy. */
const removingDeletedAlbum = state("removingDeletedAlbum")<{ adminName: string }>();
/** Gone from this phone; the notice shows until dismissed. */
const deletedByAdmin = state("deletedByAdmin")<{ adminName: string }>().final();

/** This phone's role in the album is known (Admin, Member or Viewer). */
const roleSeen = event("roleSeen")<{ role: Role }>();
/** The person archives the album on this phone. */
const archive = event("archive")();
/** The person brings the album back from Archived. */
const restore = event("restore")();
/** A Member or Viewer confirmed Leave. */
const leave = event("leave")();
/** The Admin confirmed Delete album. */
const deleteForEveryone = event("deleteForEveryone")();
/** The album's own drive carries the Admin's delete note. */
const deleteHeard = event("deleteHeard")<{ adminName: string }>();
/** The Admin's member list no longer lists this phone. */
const adminSawYouLeave = event("adminSawYouLeave")();

/** The left note is written (when the Admin lists this phone) and this phone's copy is removed. */
const leaveSaved = event("leaveSaved")<{ waiting: boolean }>();
/** The left note could not be written; nothing was removed. */
const leaveFailed = event("leaveFailed")<{ reason: string }>();
/** The delete note is written and this phone's copy is removed. */
const deleteSaved = event("deleteSaved")();
/** The delete note could not be written; nothing was removed. */
const deleteFailed = event("deleteFailed")<{ reason: string }>();
/** This phone's copy of the deleted album is removed. */
const deletedAlbumRemoved = event("deletedAlbumRemoved")();
/** The drives kept for telling the Admin are removed. */
const lastCopyRemoved = event("lastCopyRemoved")();

type LeaveResult = ReturnType<typeof leaveSaved.create> | ReturnType<typeof leaveFailed.create>;
type DeleteResult = ReturnType<typeof deleteSaved.create> | ReturnType<typeof deleteFailed.create>;

function isRole(value: unknown): value is Role {
  return value === "creator" || value === "member" || value === "reader";
}

function isRolePayload(value: unknown): value is { role: Role } {
  return typeof value === "object" && value !== null && "role" in value && isRole(value.role);
}

/** Where an album's actor starts at boot, from its saved record and what its drives say. Pure. */
export function lifecycleStart(input: {
  role: Role;
  saved: "shown" | "archived" | "leaving" | "deleting" | "waitingForAdmin";
  deleteNote?: { adminName: string };
}): LifecycleStart {
  const { role, saved, deleteNote } = input;
  if (deleteNote !== undefined && role !== "creator") {
    return { state: "removingDeletedAlbum", role, adminName: deleteNote.adminName };
  }
  if (saved === "deleting") return { state: "deletingForEveryone", role };
  if (saved === "leaving") return { state: "leavingAlbum", role };
  if (saved === "waitingForAdmin") return { state: "waitingForAdminToSeeYouLeft", role };
  if (saved === "archived") return { state: "archived", role };
  return { state: "shownInYourAlbums", role };
}

function startState(start: LifecycleStart) {
  switch (start.state) {
    case "removingDeletedAlbum":
      return removingDeletedAlbum.create({ adminName: start.adminName });
    case "archived":
      return archived;
    case "leavingAlbum":
      return leavingAlbum;
    case "waitingForAdminToSeeYouLeft":
      return waitingForAdminToSeeYouLeft;
    case "deletingForEveryone":
      return deletingForEveryone;
    case "shownInYourAlbums":
      return shownInYourAlbums;
  }
}

/** Used when no port is given, as on the flows page: every call succeeds. */
const previewPort: AlbumLifecyclePort = {
  adminListsYou: async () => true,
  writeLeftNote: async () => Either.right(),
  writeDeleteNote: async () => Either.right(),
  removeCopy: async () => {},
  forget: async () => {},
};

/** Everything but `clock` is optional so the flows page can build it from a clock alone. */
export function createAlbumLifecycleActor(options: {
  clock: Clock;
  port?: AlbumLifecyclePort;
  start?: LifecycleStart;
}) {
  const {
    clock,
    port = previewPort,
    start = { state: "shownInYourAlbums", role: "reader" },
  } = options;
  return Actor({
    inputs: [roleSeen, archive, restore, leave, deleteForEveryone, deleteHeard, adminSawYouLeave],
    internal: [
      leaveSaved,
      leaveFailed,
      deleteSaved,
      deleteFailed,
      deletedAlbumRemoved,
      lastCopyRemoved,
    ],
    outputs: [],
    states: [
      shownInYourAlbums,
      archived,
      leavingAlbum,
      waitingForAdminToSeeYouLeft,
      removingYourLastCopy,
      leftAlbum,
      deletingForEveryone,
      deletedForEveryone,
      removingDeletedAlbum,
      deletedByAdmin,
    ],
    initial: startState(start),
    /** `error: null` follows the repo's machine convention (folders-machine.ts). */
    context: { role: start.role, error: null } as LifecycleContext,
    clock,
    setup: (m) => {
      for (const at of [shownInYourAlbums, archived]) {
        /** The role is learned and kept; a payload that is not a role is ignored. */
        m.on(at, {
          event: roleSeen,
          to: [at],
          handler: (e, { context }) => {
            if (!isRolePayload(e.payload)) return {};
            context.set({ ...context.get(), role: e.payload.role });
            return { state: at };
          },
        });
        /** The album was deleted by the Admin, so this phone removes its copy. */
        m.on(at, {
          event: deleteHeard,
          to: [removingDeletedAlbum],
          handler: (e, { context }) =>
            context.get().role === "creator"
              ? {}
              : { state: removingDeletedAlbum.create({ adminName: e.payload.adminName }) },
        });
      }
      /** The person archives the album; it leaves Your albums on this phone. */
      m.on(shownInYourAlbums, {
        event: archive,
        to: [archived],
        handler: (_e, { context }) => {
          context.set({ ...context.get(), error: null });
          return { state: archived };
        },
      });
      /** The person restores the album, so it shows in Your albums again. */
      m.on(archived, {
        event: restore,
        to: [shownInYourAlbums],
        handler: (_e, { context }) => {
          context.set({ ...context.get(), error: null });
          return { state: shownInYourAlbums };
        },
      });
      /** A Member or Viewer leaves; the Admin cannot. */
      m.on(shownInYourAlbums, {
        event: leave,
        to: [leavingAlbum],
        handler: (_e, { context }) =>
          context.get().role === "creator" ? {} : { state: leavingAlbum },
      });
      /** The Admin deletes the album; nobody else can. */
      m.on(shownInYourAlbums, {
        event: deleteForEveryone,
        to: [deletingForEveryone],
        handler: (_e, { context }) =>
          context.get().role === "creator" ? { state: deletingForEveryone } : {},
      });
      /** A phone the Admin lists writes the left note and then removes the copy; any other just removes it and forgets the album. */
      m.effect(leavingAlbum, {
        name: "leaveAlbum",
        sends: [leaveSaved, leaveFailed],
        fn: (input) =>
          withPromise({
            promise: Promise.resolve().then(async (): Promise<Either<PortError, boolean>> => {
              if (!(await port.adminListsYou())) {
                await port.removeCopy("nothing");
                await port.forget();
                return Either.right(false);
              }
              const written = await port.writeLeftNote();
              if (Either.isLeft(written)) return written;
              await port.removeCopy("leftNote");
              return Either.right(true);
            }),
            signal: input.signal,
            emit: input.emit,
            events: {
              success: (result) =>
                Either.match<typeof result, LeaveResult>(result, {
                  onLeft: (err) => leaveFailed.create({ reason: err.reason }),
                  onRight: (waiting) => leaveSaved.create({ waiting }),
                }),
              error: (cause) => leaveFailed.create({ reason: String(cause) }),
            },
          }),
      });
      /** The leave is done: a phone the Admin lists waits for the Admin to see it, any other has nothing left. */
      m.on(leavingAlbum, {
        event: leaveSaved,
        to: [waitingForAdminToSeeYouLeft, leftAlbum],
        handler: (e) => ({
          state: e.payload.waiting ? waitingForAdminToSeeYouLeft : leftAlbum,
        }),
      });
      /** The leave could not be saved, so the album stays and the reason is kept. */
      m.on(leavingAlbum, {
        event: leaveFailed,
        to: [shownInYourAlbums],
        handler: (e, { context }) => {
          context.set({ ...context.get(), error: e.payload.reason });
          return { state: shownInYourAlbums };
        },
      });
      /** The Admin's member list dropped this phone, so the kept drives go. */
      m.on(waitingForAdminToSeeYouLeft, {
        event: adminSawYouLeave,
        to: [removingYourLastCopy],
        handler: () => ({ state: removingYourLastCopy }),
      });
      /** The Admin deleted the album before seeing the leave; no notice, they had left. */
      m.on(waitingForAdminToSeeYouLeft, {
        event: deleteHeard,
        to: [removingYourLastCopy],
        handler: () => ({ state: removingYourLastCopy }),
      });
      /** The drives kept for telling the Admin are removed. */
      m.effect(removingYourLastCopy, {
        name: "forgetAlbum",
        sends: [lastCopyRemoved],
        fn: (input) =>
          withPromise({
            promise: Promise.resolve().then(() => port.forget()),
            signal: input.signal,
            emit: input.emit,
            events: {
              success: () => lastCopyRemoved.create(),
              error: () => lastCopyRemoved.create(),
            },
          }),
      });
      /** Nothing of the album is left on this phone. */
      m.on(removingYourLastCopy, {
        event: lastCopyRemoved,
        to: [leftAlbum],
        handler: () => ({ state: leftAlbum }),
      });
      /** The delete note is written into the album, then this phone's copy is removed. */
      m.effect(deletingForEveryone, {
        name: "deleteForEveryone",
        sends: [deleteSaved, deleteFailed],
        fn: (input) =>
          withPromise({
            promise: Promise.resolve().then(async (): Promise<Either<PortError, void>> => {
              const written = await port.writeDeleteNote();
              if (Either.isLeft(written)) return written;
              await port.removeCopy("deleteNote");
              return Either.right();
            }),
            signal: input.signal,
            emit: input.emit,
            events: {
              success: (result) =>
                Either.match<typeof result, DeleteResult>(result, {
                  onLeft: (err) => deleteFailed.create({ reason: err.reason }),
                  onRight: () => deleteSaved.create(),
                }),
              error: (cause) => deleteFailed.create({ reason: String(cause) }),
            },
          }),
      });
      /** The delete note is saved and the photos are gone from the Admin's phone. */
      m.on(deletingForEveryone, {
        event: deleteSaved,
        to: [deletedForEveryone],
        handler: () => ({ state: deletedForEveryone }),
      });
      /** The delete note could not be written, so the album stays and the reason is kept. */
      m.on(deletingForEveryone, {
        event: deleteFailed,
        to: [shownInYourAlbums],
        handler: (e, { context }) => {
          context.set({ ...context.get(), error: e.payload.reason });
          return { state: shownInYourAlbums };
        },
      });
      /** This phone's copy of the deleted album is removed. */
      m.effect(removingDeletedAlbum, {
        name: "removeDeletedAlbum",
        sends: [deletedAlbumRemoved],
        fn: (input) =>
          withPromise({
            promise: Promise.resolve().then(() => port.removeCopy("nothing")),
            signal: input.signal,
            emit: input.emit,
            events: {
              success: () => deletedAlbumRemoved.create(),
              error: () => deletedAlbumRemoved.create(),
            },
          }),
      });
      /** The copy is gone, so the notice names the Admin who deleted the album. */
      m.on(removingDeletedAlbum, {
        event: deletedAlbumRemoved,
        to: [deletedByAdmin],
        handler: (_e, { actor }) => {
          const { payload } = actor.snapshot();
          const adminName =
            typeof payload === "object" && payload !== null && "adminName" in payload
              ? String(payload.adminName)
              : "The Admin";
          return { state: deletedByAdmin.create({ adminName }) };
        },
      });
    },
  });
}

/** What fuzzing must never see: the wrong role in a state that only another role can reach. */
export const albumLifecycleExpectations: Expectations<typeof createAlbumLifecycleActor> = {
  leavingAlbum: { neverSee: [{ role: "creator" }] },
  waitingForAdminToSeeYouLeft: { neverSee: [{ role: "creator" }] },
  deletingForEveryone: { neverSee: [{ role: "member" }, { role: "reader" }] },
  deletedForEveryone: { neverSee: [{ role: "member" }, { role: "reader" }] },
  removingDeletedAlbum: { neverSee: [{ role: "creator" }] },
  deletedByAdmin: { neverSee: [{ role: "creator" }] },
};
