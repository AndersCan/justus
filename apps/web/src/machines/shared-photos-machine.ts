import { Actor, event, machine, state, type Snapshot } from "@mantaq/core";
import type { SharedBatch } from "@justus/core";
import { gateway } from "../gateway";
import { runInvoke } from "./actor-utils";

/**
 * Photos other apps shared to Justus wait in the phone's inbox as copies. When
 * some wait, a sheet asks which album they go into. Once they are in the
 * album, or she closes the sheet, they leave the inbox: the originals stay in
 * the other app, so nothing waits and nothing asks again.
 */

export type SharedPhotosPort = Pick<typeof gateway.sharedIn, "remove">;

export type SharedPhotosContext = {
  /** The batches the inbox listed last. */
  waiting: SharedBatch[];
  /** The batches on the open sheet, then being added or removed. */
  shown: SharedBatch[];
  /** False while the first-run welcome is on screen. */
  canAsk: boolean;
};

/** Nothing waits; nothing is shown. */
const noSharedPhotos = state("noSharedPhotos")();
/** The sheet "Add 3 photos to" is open over the page, with the albums she can add to. */
const choosingAlbumForSharedPhotos = state("choosingAlbumForSharedPhotos")();
/** The album's add is running; the photos stay in the inbox until it ends. */
const addingSharedPhotos = state("addingSharedPhotos")();
/** Every photo went in, or she closed the sheet; the batches are being removed from the inbox. */
const clearingSharedPhotos = state("clearingSharedPhotos")();

/** The inbox was listed (at start or after another app shared). */
const sharedPhotosListed = event("SHARED_PHOTOS_LISTED")<{ batches: SharedBatch[] }>();
/** A page is on screen; `welcome` is the first-run welcome. */
const pageShown = event("PAGE_SHOWN")<{ welcome: boolean }>();
/** She closed the sheet: Not now, Escape or a tap outside. */
const notNowTapped = event("NOT_NOW")();
/** The album she tapped took the photos and the add started. */
const addStarted = event("ADD_STARTED")<{ folderId: string }>();
/** The add batch ended; `failed` photos did not go in. */
const addEnded = event("ADD_ENDED")<{ failed: number }>();
/** The shown batches left the inbox. */
const inboxCleared = event("INBOX_CLEARED")();
/** The shown batches could not be removed from the inbox. */
const inboxClearFailed = event("INBOX_CLEAR_FAILED")<{ message: string }>();

const initialContext: SharedPhotosContext = { waiting: [], shown: [], canAsk: true };

/** Batches in `from` whose id is not in `gone`. */
function without(from: SharedBatch[], gone: SharedBatch[]): SharedBatch[] {
  const ids = gone.map((b) => b.id);
  return from.filter((b) => !ids.includes(b.id));
}

/** The port is injected so tests can drive the machine. */
export const sharedPhotosMachine = machine("sharedPhotos", {
  create: (options: { port?: SharedPhotosPort }) => {
    const { port = gateway.sharedIn } = options;

    return Actor({
      inputs: [sharedPhotosListed, pageShown, notNowTapped, addStarted, addEnded],
      internal: [inboxCleared, inboxClearFailed],
      outputs: [],
      states: [
        noSharedPhotos,
        choosingAlbumForSharedPhotos,
        addingSharedPhotos,
        clearingSharedPhotos,
      ],
      initial: noSharedPhotos,
      context: initialContext,
      setup: (m) => {
        /** Everything waiting goes on one sheet. */
        const ask = (
          ctx: SharedPhotosContext,
          opts: { context: { set(c: SharedPhotosContext): void } },
        ) => {
          opts.context.set({ ...ctx, shown: ctx.waiting });
          return { state: choosingAlbumForSharedPhotos };
        };

        /** The inbox was listed: if photos wait and no welcome is up, the sheet opens. */
        m.on(noSharedPhotos, {
          event: sharedPhotosListed,
          to: [choosingAlbumForSharedPhotos],
          handler: (e, opts) => {
            const ctx = { ...opts.context.get(), waiting: e.payload.batches };
            if (ctx.canAsk && ctx.waiting.length > 0) return ask(ctx, opts);
            opts.context.set(ctx);
            return {};
          },
        });
        /** A page appeared: once the welcome is gone, waiting photos open the sheet. */
        m.on(noSharedPhotos, {
          event: pageShown,
          to: [choosingAlbumForSharedPhotos],
          handler: (e, opts) => {
            const ctx = { ...opts.context.get(), canAsk: !e.payload.welcome };
            if (ctx.canAsk && ctx.waiting.length > 0) return ask(ctx, opts);
            opts.context.set(ctx);
            return {};
          },
        });
        for (const at of [choosingAlbumForSharedPhotos, addingSharedPhotos, clearingSharedPhotos]) {
          /** The open sheet keeps its count; only what waits is updated. */
          m.on(at, {
            event: sharedPhotosListed,
            handler: (e, opts) => {
              opts.context.set({ ...opts.context.get(), waiting: e.payload.batches });
              return {};
            },
          });
          /** The welcome coming or going changes whether the sheet may open next. */
          m.on(at, {
            event: pageShown,
            handler: (e, opts) => {
              opts.context.set({ ...opts.context.get(), canAsk: !e.payload.welcome });
              return {};
            },
          });
        }

        /** She closed the sheet: the shared copies are removed, the originals stay in the other app. */
        m.on(choosingAlbumForSharedPhotos, {
          event: notNowTapped,
          to: [clearingSharedPhotos],
          handler: () => ({ state: clearingSharedPhotos }),
        });
        /** An album took the photos and the add started. */
        m.on(choosingAlbumForSharedPhotos, {
          event: addStarted,
          to: [addingSharedPhotos],
          handler: () => ({ state: addingSharedPhotos }),
        });
        /** Every photo went in: the shared copies are removed. */
        m.on(addingSharedPhotos, {
          event: addEnded,
          to: [clearingSharedPhotos, noSharedPhotos],
          handler: (e, opts) => {
            if (e.payload.failed === 0) return { state: clearingSharedPhotos };
            // The inbox keeps them; the next start offers what is left.
            console.warn("justus:share-in.add-failed", e.payload.failed);
            const ctx = opts.context.get();
            opts.context.set({ ...ctx, waiting: without(ctx.waiting, ctx.shown), shown: [] });
            return { state: noSharedPhotos };
          },
        });

        /** The shown batches are removed from the inbox. */
        m.effect(clearingSharedPhotos, {
          name: "removingFromInbox",
          sends: [inboxCleared, inboxClearFailed],
          fn: ({ signal, emit, context }) =>
            runInvoke(
              signal,
              () => port.remove(context.get().shown.map((b) => b.id)),
              () => emit(inboxCleared.create()),
              (message) => emit(inboxClearFailed.create({ message })),
            ),
        });
        /** The batches left the inbox; a share that came meanwhile gets its own sheet. */
        m.on(clearingSharedPhotos, {
          event: inboxCleared,
          to: [choosingAlbumForSharedPhotos, noSharedPhotos],
          handler: (_e, opts) => {
            const ctx = opts.context.get();
            const next = { ...ctx, waiting: without(ctx.waiting, ctx.shown), shown: [] };
            if (next.canAsk && next.waiting.length > 0) return ask(next, opts);
            opts.context.set(next);
            return { state: noSharedPhotos };
          },
        });
        /** The batches could not be removed; the next start offers them again. */
        m.on(clearingSharedPhotos, {
          event: inboxClearFailed,
          to: [noSharedPhotos],
          handler: (e, opts) => {
            console.warn("justus:share-in.remove-failed", e.payload.message);
            const ctx = opts.context.get();
            opts.context.set({ ...ctx, waiting: without(ctx.waiting, ctx.shown), shown: [] });
            return { state: noSharedPhotos };
          },
        });
      },
    });
  },
});

export const sharedPhotosActor = sharedPhotosMachine.create({});

export const sharedPhotos = {
  listed: (batches: SharedBatch[]) =>
    sharedPhotosActor.send(sharedPhotosListed.create({ batches })),
  pageShown: (welcome: boolean) => sharedPhotosActor.send(pageShown.create({ welcome })),
  notNow: () => sharedPhotosActor.send(notNowTapped.create()),
  addStarted: (folderId: string) => sharedPhotosActor.send(addStarted.create({ folderId })),
  addEnded: (failed: number) => sharedPhotosActor.send(addEnded.create({ failed })),
};

/** What the sheet reads: open or not, and the photos on it. */
export function sharedPhotosViewOf(s: Snapshot<SharedPhotosContext>): {
  asking: boolean;
  batches: SharedBatch[];
  count: number;
} {
  const batches = s.context.shown;
  return {
    asking: s.path[0] === "choosingAlbumForSharedPhotos",
    batches,
    count: batches.reduce((n, b) => n + b.photos.length, 0),
  };
}
