import { Actor, event, machine, state, type Snapshot } from "@mantaq/core";
import type { SeenRecord } from "@justus/core";
import { gateway } from "../gateway";
import { runInvoke } from "./actor-utils";

/**
 * What this phone has looked at, kept in a file the phone owns. A photo is new
 * when its album was listed before, the photo was not in that listing or in
 * anything looked at since, and it is not the person's own. The marks shown
 * are frozen per visit: looking at a photo changes the saved record at once
 * but the mark stays until the person leaves the page.
 */

export type SeenPort = Pick<typeof gateway.seen, "read" | "write">;

type SeenContext = {
  lastAlbum?: string;
  known: Record<string, string[]>;
  knownAtVisitStart: Record<string, string[]>;
  /** The phone's seen file could not be read: nothing is marked and nothing is written. */
  unreadable: boolean;
};

/** The phone's seen file is being read; inputs wait for it. */
const readingSeen = state("readingSeen")();
/** The record is in memory; every change is saved to the phone. */
const holdingSeen = state("holdingSeen")();

/** Albums were listed with their photos. */
const albumsListed = event("ALBUMS_LISTED")<{
  albums: { albumId: string; photoIds: string[] }[];
}>();
/** The person opened an album's photo page. */
const albumOpened = event("ALBUM_OPENED")<{ albumId: string }>();
/** Photos stayed on screen long enough to count as looked at. */
const photosLooked = event("PHOTOS_LOOKED")<{ photos: { albumId: string; photoId: string }[] }>();
/** The person left the page; what they looked at stops being new. */
const visitEnded = event("VISIT_ENDED")();
/** The saved record was read from the phone. */
const seenRead = event("SEEN_READ")<{ seen: SeenRecord }>();
/** The saved record could not be read. */
const seenReadFailed = event("SEEN_READ_FAILED")<{ message: string }>();

const initialContext: SeenContext = { known: {}, knownAtVisitStart: {}, unreadable: false };

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
    states: [readingSeen, holdingSeen],
    initial: readingSeen,
    context: initialContext,
    setup: (m) => {
      /** The saved record is read from the phone; if that fails, nothing is marked or written. */
      m.effect(readingSeen, {
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
      m.on(readingSeen, {
        event: seenRead,
        to: [holdingSeen],
        handler: (e, opts) => {
          const { lastAlbum, known } = e.payload.seen;
          opts.context.set({ lastAlbum, known, knownAtVisitStart: known, unreadable: false });
          return { state: holdingSeen };
        },
      });
      m.on(readingSeen, {
        event: seenReadFailed,
        to: [holdingSeen],
        handler: (_e, opts) => {
          opts.context.set({ ...initialContext, unreadable: true });
          return { state: holdingSeen };
        },
      });

      /** An album listed for the first time with photos starts its record: those photos are not new. */
      m.on(holdingSeen, {
        event: albumsListed,
        to: [holdingSeen],
        handler: (e, opts) => {
          const ctx = opts.context.get();
          if (ctx.unreadable) return { state: holdingSeen };
          const known = { ...ctx.known };
          const atStart = { ...ctx.knownAtVisitStart };
          let added = false;
          for (const { albumId, photoIds } of e.payload.albums) {
            if (known[albumId] !== undefined || photoIds.length === 0) continue;
            known[albumId] = photoIds;
            atStart[albumId] = photoIds;
            added = true;
          }
          if (!added) return { state: holdingSeen };
          const next = { ...ctx, known, knownAtVisitStart: atStart };
          opts.context.set(next);
          save(next);
          return { state: holdingSeen };
        },
      });
      /** The album opened last is remembered. */
      m.on(holdingSeen, {
        event: albumOpened,
        to: [holdingSeen],
        handler: (e, opts) => {
          const ctx = opts.context.get();
          if (ctx.unreadable || ctx.lastAlbum === e.payload.albumId) return { state: holdingSeen };
          const next = { ...ctx, lastAlbum: e.payload.albumId };
          opts.context.set(next);
          save(next);
          return { state: holdingSeen };
        },
      });
      /** Looked-at photos are saved as known; the marks on screen stay until the visit ends. */
      m.on(holdingSeen, {
        event: photosLooked,
        to: [holdingSeen],
        handler: (e, opts) => {
          const ctx = opts.context.get();
          if (ctx.unreadable) return { state: holdingSeen };
          const known = { ...ctx.known };
          let added = false;
          for (const { albumId, photoId } of e.payload.photos) {
            const ids = known[albumId];
            if (ids === undefined || ids.includes(photoId)) continue;
            known[albumId] = [...ids, photoId];
            added = true;
          }
          if (!added) return { state: holdingSeen };
          const next = { ...ctx, known };
          opts.context.set(next);
          save(next);
          return { state: holdingSeen };
        },
      });
      /** Leaving the page drops the marks of what was looked at. */
      m.on(holdingSeen, {
        event: visitEnded,
        to: [holdingSeen],
        handler: (_e, opts) => {
          const ctx = opts.context.get();
          opts.context.set({ ...ctx, knownAtVisitStart: ctx.known });
          return { state: holdingSeen };
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
  if (snapshot.path[0] === "readingSeen") return "reading";
  return snapshot.context.unreadable ? "unreadable" : "ready";
}

export const seenActor = seenMachine.create({});

export const seen = {
  albumsListed: (albums: { albumId: string; photoIds: string[] }[]) =>
    seenActor.send(albumsListed.create({ albums })),
  albumOpened: (albumId: string) => seenActor.send(albumOpened.create({ albumId })),
  photosLooked: (photos: { albumId: string; photoId: string }[]) =>
    seenActor.send(photosLooked.create({ photos })),
  visitEnded: () => seenActor.send(visitEnded.create()),
};
