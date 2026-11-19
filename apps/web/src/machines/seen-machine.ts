import { Actor, event, machine, state, type Snapshot } from "@mantaq/core";
import type { SeenRecord } from "@justus/core";
import { gateway } from "../gateway";
import { runInvoke } from "./actor-utils";

/**
 * What this phone has looked at, kept in a file the phone owns. A photo is new
 * when its album was listed before, the photo was not in the album when its
 * page was last opened or looked at on that page since, and it is not the
 * person's own. Opening an album saves its photos as known; the marks stay
 * until the person leaves the page. Looking at photos elsewhere, such as
 * Photos > All, marks nothing.
 */

export type SeenPort = Pick<typeof gateway.seen, "read" | "write">;

export type SeenContext = {
  lastAlbum?: string;
  known: Record<string, string[]>;
  knownAtVisitStart: Record<string, string[]>;
  /** Until the phone's seen file is read, and when it cannot be, nothing is marked and nothing is written. */
  status: "reading" | "ready" | "unreadable";
};

/** The record is in memory; every change is saved to the phone. */
const holdingSeen = state("holdingSeen")();

/** Albums were listed with their photos. */
const albumsListed = event("ALBUMS_LISTED")<{
  albums: { albumId: string; photoIds: string[] }[];
}>();
/** The album's photo page opened with these photos in it. */
const albumOpened = event("ALBUM_OPENED")<{ albumId: string; photoIds: string[] }>();
/** Photos stayed on screen long enough on an album page to count as looked at. */
const photosLooked = event("PHOTOS_LOOKED")<{ photos: { albumId: string; photoId: string }[] }>();
/** The person left the page; what they looked at stops being new. */
const visitEnded = event("VISIT_ENDED")();
/** The saved record was read from the phone. */
const seenRead = event("SEEN_READ")<{ seen: SeenRecord }>();
/** The saved record could not be read. */
const seenReadFailed = event("SEEN_READ_FAILED")<{ message: string }>();

const initialContext: SeenContext = { known: {}, knownAtVisitStart: {}, status: "reading" };

/** The port is injected so tests can drive the machine. */
export const seenMachine = machine("seen", {
  create: (options: { port?: SeenPort }) => {
    const { port = gateway.seen } = options;

    /** Saves the whole record; a failure is logged and the next change writes it again. */
    const save = (ctx: SeenContext) => {
      const record: SeenRecord = { version: 1, known: ctx.known };
      if (ctx.lastAlbum !== undefined) record.lastAlbum = ctx.lastAlbum;
      port.write(record).then(
        ([err]) => {
          if (err) console.error("seen: could not save", err);
        },
        (e) => console.error("seen: could not save", e),
      );
    };

    return Actor({
      inputs: [albumsListed, albumOpened, photosLooked, visitEnded],
      internal: [seenRead, seenReadFailed],
      outputs: [],
      states: [holdingSeen],
      initial: holdingSeen,
      context: initialContext,
      setup: (m) => {
        /** The saved record is read from the phone; if that fails, nothing is marked or written. */
        m.effect(holdingSeen, {
          name: "readingSeen",
          sends: [seenRead, seenReadFailed],
          fn: ({ signal, emit }) =>
            runInvoke(
              signal,
              () => port.read(),
              (result) => {
                const seen = (result as { seen?: SeenRecord } | null)?.seen;
                if (seen === undefined) emit(seenReadFailed.create({ message: "no record" }));
                else emit(seenRead.create({ seen }));
              },
              (message) => {
                console.error("seen: could not read", message);
                emit(seenReadFailed.create({ message }));
              },
            ),
        });
        /** The saved record arrived: its albums start the visit as known. */
        m.onAny({
          event: seenRead,
          handler: (e, opts) => {
            const { lastAlbum, known } = e.payload.seen;
            opts.context.set({ lastAlbum, known, knownAtVisitStart: known, status: "ready" });
            return {};
          },
        });
        /** The saved record could not be read: nothing is marked and nothing is written. */
        m.onAny({
          event: seenReadFailed,
          handler: (_e, opts) => {
            opts.context.set({ ...initialContext, status: "unreadable" });
            return {};
          },
        });

        /** An album listed for the first time with photos starts its record: those photos are not new. */
        m.onAny({
          event: albumsListed,
          handler: (e, opts) => {
            const ctx = opts.context.get();
            if (ctx.status !== "ready") return {};
            const known = { ...ctx.known };
            const atStart = { ...ctx.knownAtVisitStart };
            let added = false;
            for (const { albumId, photoIds } of e.payload.albums) {
              if (known[albumId] !== undefined || photoIds.length === 0) continue;
              known[albumId] = photoIds;
              atStart[albumId] = photoIds;
              added = true;
            }
            if (!added) return {};
            const next = { ...ctx, known, knownAtVisitStart: atStart };
            opts.context.set(next);
            save(next);
            return {};
          },
        });
        /** The opened album is remembered and its photos saved as known; the marks stay until the visit ends. */
        m.onAny({
          event: albumOpened,
          handler: (e, opts) => {
            const ctx = opts.context.get();
            if (ctx.status !== "ready") return {};
            const { albumId, photoIds } = e.payload;
            const ids = ctx.known[albumId];
            const have = new Set(ids);
            const added = ids === undefined ? [] : photoIds.filter((id) => !have.has(id));
            const known =
              ids === undefined ? ctx.known : { ...ctx.known, [albumId]: [...ids, ...added] };
            const next = { ...ctx, known, lastAlbum: albumId };
            opts.context.set(next);
            save(next);
            return {};
          },
        });
        /** Looked-at photos are saved as known; the marks on screen stay until the visit ends. */
        m.onAny({
          event: photosLooked,
          handler: (e, opts) => {
            const ctx = opts.context.get();
            const known = { ...ctx.known };
            let added = false;
            for (const { albumId, photoId } of e.payload.photos) {
              const ids = known[albumId];
              if (ids === undefined || ids.includes(photoId)) continue;
              known[albumId] = [...ids, photoId];
              added = true;
            }
            if (!added) return {};
            const next = { ...ctx, known };
            opts.context.set(next);
            save(next);
            return {};
          },
        });
        /** Leaving the page drops the marks of what was looked at. */
        m.onAny({
          event: visitEnded,
          handler: (_e, opts) => {
            const ctx = opts.context.get();
            opts.context.set({ ...ctx, knownAtVisitStart: ctx.known });
            return {};
          },
        });
      },
    });
  },
});

type SeenPhoto = { id: string; folderId?: string; mine?: boolean };

/** A photo is new when its album has a record from before this visit, the photo is not in it, and it is not the person's own. */
export function isNewPhoto(ctx: SeenContext, photo: SeenPhoto): boolean {
  if (photo.mine === true || photo.folderId === undefined) return false;
  const ids = ctx.knownAtVisitStart[photo.folderId];
  return ids !== undefined && !ids.includes(photo.id);
}

/** How many photos are new, in the given albums only when `albumIds` is given. */
export function newCount(ctx: SeenContext, photos: SeenPhoto[], albumIds?: string[]): number {
  return photos.filter(
    (p) =>
      isNewPhoto(ctx, p) &&
      (albumIds === undefined || (p.folderId !== undefined && albumIds.includes(p.folderId))),
  ).length;
}

/** Whether the record is still being read, usable, or could not be read. */
export function seenReady(snapshot: Snapshot<SeenContext>): "reading" | "ready" | "unreadable" {
  return snapshot.context.status;
}

export const seenActor = seenMachine.create({});

export const seen = {
  albumsListed: (albums: { albumId: string; photoIds: string[] }[]) =>
    seenActor.send(albumsListed.create({ albums })),
  albumOpened: (albumId: string, photoIds: string[]) =>
    seenActor.send(albumOpened.create({ albumId, photoIds })),
  photosLooked: (photos: { albumId: string; photoId: string }[]) =>
    seenActor.send(photosLooked.create({ photos })),
  visitEnded: () => seenActor.send(visitEnded.create()),
};
