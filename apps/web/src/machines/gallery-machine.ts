import { Actor, RealClock, event, state, type Clock, type Snapshot } from "@mantaq/core";
import type { Photo, PickedMedia, SyncStatus } from "@justus/core";
import { gateway } from "../gateway";
import { fatalErrorOf, runInvoke, stateNameOf } from "./actor-utils";

/**
 * The gallery state machine. All gallery state lives here (a mantaq actor);
 * its context holds the in-flight add batch / remove id the effects read. The shell
 * (gateway) performs plugin invokes; this actor owns the flow. Every invoke
 * is wrapped so a transport failure surfaces as a modeled failure event —
 * never an unhandled rejection (which would wedge the machine in `busy`).
 */

const GALLERY_STATES = [
  "booting",
  "loading",
  "ready",
  "error",
  "adding",
  "removing",
  "couldNotRemovePhoto",
] as const;
export type GalleryStateName = (typeof GALLERY_STATES)[number];

/** One photo to add: a file the native host staged (`path`, with the shared
 * copies it made, see `PickedMedia`), or a file the browser picked (encoded
 * and posted to the worklet's upload route). */
export type AddSource = ({ kind: "path" } & PickedMedia) | { kind: "file"; file: File };

export const sourceName = (source: AddSource): string =>
  source.kind === "file" ? source.file.name : (source.name ?? source.path.split("/").pop() ?? "");

/** Progress of the current (or last) add batch. Photos are added one at a
 * time; one that fails is recorded and the rest carry on. `duplicates` are
 * photos the album already held (the backend dedupes by content). */
export type AddBatch = {
  folderId?: string;
  total: number;
  done: number;
  added: number;
  duplicates: number;
  failed: { source: AddSource; message: string }[];
  running: boolean;
};

const nameOf = stateNameOf(GALLERY_STATES);

/** The gallery UI's view model as a pure function of the actor snapshot.
 * `busy` is exactly "an add or remove is in flight"; `role` comes from the
 * sync status passed in, so the empty state can be reader-aware. */
export function galleryViewModel(s: Snapshot<GalleryContext>, status: SyncStatus | null) {
  const state = nameOf(s);
  const fatal = fatalErrorOf(s);
  return {
    state,
    busy: state === "adding" || state === "removing",
    /** The photos are shown and nothing is in flight: fine, or the last remove failed. */
    settled: state === "ready" || state === "couldNotRemovePhoto",
    error: fatal?.message ?? s.context.error,
    fatal: fatal !== null,
    photos: s.context.photos,
    role: status?.folder?.role ?? null,
  };
}

/** Photo ids are only unique within an album; the list spans all of them. */
export function samePhoto(
  a: { id: string; folderId?: string },
  b: { id: string; folderId?: string },
): boolean {
  return a.id === b.id && a.folderId === b.folderId;
}

/** Identity of a photo across syncs: every sync brings new Photo objects. */
export function photoKey(photo: { id: string; folderId?: string }): string {
  return `${photo.folderId ?? ""}/${photo.id}`;
}

/** The app has just started and no photos are loaded. */
const booting = state("booting")();
/** The photo list is loading. */
const loading = state("loading")();
/** Photos are shown and the person can add or remove them. */
const ready = state("ready")();
/** The photos could not be loaded; the person can try again. */
const error = state("error")();
/** Photos are being added to the album one by one with progress. */
const adding = state("adding")();
/** A photo is being removed. */
const removing = state("removing")();

/** The photo was not removed; it stays and the person sees why. */
const couldNotRemovePhoto = state("couldNotRemovePhoto")();

/** The app asks for the latest photos, including when the album syncs. */
const load = event("LOAD")();
/** The photo list arrived. */
const loaded = event("LOADED")<{ photos: Photo[] }>();
/** The photo list could not be loaded. */
const loadFailed = event("LOAD_FAILED")<{ message: string }>();
/** The person picks photos to add to an album. */
const addMany = event("ADD_MANY")<{ sources: AddSource[]; folderId?: string }>();
/** One photo finished adding, or was already in the album. */
const itemAdded = event("ITEM_ADDED")<{ photo: Photo | null; duplicate: boolean }>();
/** One photo could not be added. */
const itemFailed = event("ITEM_FAILED")<{ source: AddSource; message: string }>();
/** Every picked photo has been tried. */
const batchDone = event("BATCH_DONE")();
/** The person retries the photos that failed to add. */
const retryFailed = event("RETRY_FAILED")();
/** The person closes the add summary. */
const dismissBatch = event("DISMISS_BATCH")();
/** The person removes a photo from the album. */
const remove = event("REMOVE")<{ id: string; folderId?: string }>();
/** The photo was removed. */
const removed = event("REMOVED")<{ id: string; folderId?: string }>();
/** The photo could not be removed. */
const removeFailed = event("REMOVE_FAILED")<{ message: string }>();
/** The person taps Try again after an error. */
const retry = event("RETRY")();
/** The backend pushed a photos change; `at` is when (ms since epoch). */
const synced = event("SYNCED")<{ at: number }>();

type GalleryContext = {
  pendingAdd: { sources: AddSource[]; folderId?: string } | null;
  pendingRemove: { id: string; folderId?: string } | null;
  /** A `photos.changed` push arrived mid-batch or mid-load: reload once the
   * batch or the in-flight list ends, so nothing is missed. */
  reloadAfterAdd: boolean;
  photos: Photo[];
  batch: AddBatch | null;
  error: string | null;
  /** When the last `photos.changed` push arrived — feeds the "last synced" hint. */
  lastSyncAt: number | undefined;
};
type GalleryPort = Pick<typeof gateway, "list" | "upload" | "add" | "remove">;

/** Back to idle: the pending work is cleared, the photos, the add summary and the error stay. */
const idleContext = (c: GalleryContext, change: Partial<GalleryContext> = {}): GalleryContext => ({
  pendingAdd: null,
  pendingRemove: null,
  reloadAfterAdd: false,
  photos: c.photos,
  batch: c.batch,
  error: c.error,
  lastSyncAt: c.lastSyncAt,
  ...change,
});

/** Adds one photo. A browser upload answers with only an id; the push it
 * triggers brings the full photo in on the reload after the batch. */
function addOne(
  port: GalleryPort,
  source: AddSource,
  folderId?: string,
): Promise<[unknown, unknown]> {
  if (source.kind === "file") return port.upload(source.file, folderId);
  const { path, name, thumb, original, takenAt } = source;
  const extras = Object.fromEntries(
    Object.entries({ thumb, original, takenAt }).filter(([, v]) => v !== undefined),
  );
  return port.add(path, name, folderId, extras);
}

/** The gallery runs through `gateway` and the clock is injected, so tests and the flow inspector can drive it. */
export function createGalleryActor(options: { clock: Clock; gateway?: GalleryPort }) {
  const port = options.gateway ?? gateway;
  return Actor({
    inputs: [load, addMany, remove, retry, retryFailed, dismissBatch, synced],
    internal: [loaded, loadFailed, itemAdded, itemFailed, batchDone, removed, removeFailed],
    outputs: [],
    states: [booting, loading, ready, error, adding, removing, couldNotRemovePhoto],
    initial: booting,
    clock: options.clock,
    context: idleContext({ photos: [], batch: null, error: null } as unknown as GalleryContext),
    setup: (m) => {
      /** A photos push arrived: the time is kept for the "last synced" hint, in any state. */
      m.onAny({
        event: synced,
        handler: (e, opts) => {
          opts.context.set({ ...opts.context.get(), lastSyncAt: e.payload.at });
          return {};
        },
      });
      /** The first load of photos starts. */
      m.on(booting, {
        event: load,
        to: [loading],
        handler: (_e, opts) => {
          opts.context.set(idleContext(opts.context.get(), { error: null }));
          return { state: loading };
        },
      });
      for (const at of [ready, couldNotRemovePhoto]) {
        /** Refreshing the photos starts a reload. */
        m.on(at, {
          event: load,
          to: [loading],
          handler: (_e, opts) => {
            opts.context.set(idleContext(opts.context.get(), { error: null }));
            return { state: loading };
          },
        });
      }
      /** After an error, reloading starts again and clears the error. */
      m.on(error, {
        event: load,
        to: [loading],
        handler: (_e, opts) => {
          opts.context.set(idleContext(opts.context.get(), { error: null }));
          return { state: loading };
        },
      });
      /** Try again after an error reloads the photos. */
      m.on(error, {
        event: retry,
        to: [loading],
        handler: (_e, opts) => {
          opts.context.set(idleContext(opts.context.get(), { error: null }));
          return { state: loading };
        },
      });

      /** The photos are fetched from the album. */
      m.effect(loading, {
        name: "loading",
        sends: [loaded, loadFailed],
        fn: ({ signal, emit }) => {
          return runInvoke(
            signal,
            () => port.list(),
            (result) => {
              const photos = (result as { photos?: Photo[] } | null)?.photos;
              if (!photos) {
                emit(loadFailed.create({ message: "list returned no photos" }));
                return;
              }
              emit(loaded.create({ photos }));
            },
            (message) => emit(loadFailed.create({ message })),
          );
        },
      });

      /** The photos are shown; photos picked while loading start adding now, and another sync during the load triggers one more reload. */
      m.on(loading, {
        event: loaded,
        to: [loading, ready, adding],
        handler: (e, opts) => {
          const c = opts.context.get();
          // Photos picked while the list was loading start adding now.
          if (c.pendingAdd) {
            opts.context.set({ ...c, photos: e.payload.photos, error: null });
            return { state: adding };
          }
          // A push during the load may name photos this list predates.
          opts.context.set(idleContext(c, { photos: e.payload.photos, error: null }));
          return { state: c.reloadAfterAdd ? loading : ready };
        },
      });
      /** Loading failed and an error is shown; photos already picked still start adding. */
      m.on(loading, {
        event: loadFailed,
        to: [error, adding],
        handler: (e, opts) => {
          const c = opts.context.get();
          if (c.pendingAdd) {
            opts.context.set({ ...c, error: e.payload.message });
            return { state: adding };
          }
          opts.context.set(idleContext(c, { error: e.payload.message }));
          return { state: error };
        },
      });

      const queueBatch = (
        sources: AddSource[],
        folderId: string | undefined,
        opts: { context: { get(): GalleryContext; set(c: GalleryContext): void } },
        change: Partial<GalleryContext> = {},
      ) => {
        opts.context.set(
          idleContext(opts.context.get(), {
            ...change,
            batch: {
              folderId,
              total: sources.length,
              done: 0,
              added: 0,
              duplicates: 0,
              failed: [],
              running: true,
            },
            pendingAdd: { sources, folderId },
          }),
        );
      };
      const startBatch = (
        sources: AddSource[],
        folderId: string | undefined,
        opts: { context: { get(): GalleryContext; set(c: GalleryContext): void } },
      ) => {
        queueBatch(sources, folderId, opts, { error: null });
        return { state: adding };
      };
      for (const at of [ready, couldNotRemovePhoto]) {
        /** The person adds photos and sees progress through the batch. */
        m.on(at, {
          event: addMany,
          to: [adding],
          handler: (e, opts) => startBatch(e.payload.sources, e.payload.folderId, opts),
        });
      }
      // A `photos.changed` push reloads the list often (every sync). Photos
      // picked meanwhile must not be dropped: queue them, shown as adding, and
      // start once the list is in.
      for (const at of [booting, loading]) {
        /** Photos picked while the list is still loading are queued and start once it arrives. */
        m.on(at, {
          event: addMany,
          handler: (e, opts) => {
            if (opts.context.get().pendingAdd) return {};
            queueBatch(e.payload.sources, e.payload.folderId, opts);
            return {};
          },
        });
      }
      for (const at of [ready, couldNotRemovePhoto]) {
        /** Retrying adds only the photos that failed earlier, if none are still being added. */
        m.on(at, {
          event: retryFailed,
          handler: (_e, opts) => {
            const last = opts.context.get().batch;
            if (!last || last.running || last.failed.length === 0) return {};
            return startBatch(
              last.failed.map((f) => f.source),
              last.folderId,
              opts,
            );
          },
        });
      }
      // A finished batch can be dismissed whatever the gallery is doing (an
      // upload batch ends in a reload); only the running one stays.
      for (const at of [booting, loading, ready, error, removing, couldNotRemovePhoto]) {
        /** The add summary can be closed at any time, unless photos are still being added. */
        m.on(at, {
          event: dismissBatch,
          handler: (_e, opts) => {
            const c = opts.context.get();
            if (!c.batch?.running) opts.context.set({ ...c, batch: null });
            return {};
          },
        });
      }
      // One photo at a time: the worklet writes each to the album's drive in
      // turn, and the progress count stays honest.
      /** Each picked photo is added in turn, and the progress count goes up after each. */
      m.effect(adding, {
        name: "adding",
        sends: [itemAdded, itemFailed, batchDone],
        fn: ({ signal, emit, context }) => {
          const batch = context.get().pendingAdd;
          if (!batch || batch.sources.length === 0) {
            emit(batchDone.create());
            return;
          }
          // Ids already in the album, to tell a deduped re-add from a new photo.
          const key = (id: string, folderId?: string) => `${folderId ?? ""}/${id}`;
          const held = new Set(context.get().photos.map((p) => key(p.id, p.folderId)));
          return (async () => {
            for (const source of batch.sources) {
              if (signal.aborted) return;
              await runInvoke(
                signal,
                () => addOne(port, source, batch.folderId),
                (result) => {
                  const r = result as Partial<Photo> | null;
                  if (!r?.id) {
                    emit(itemFailed.create({ source, message: "add returned no photo" }));
                    return;
                  }
                  const id = key(r.id, r.folderId ?? batch.folderId);
                  const duplicate = held.has(id);
                  held.add(id);
                  // A path add answers with the photo; an upload with its id only.
                  const photo = source.kind === "path" ? (r as Photo) : null;
                  emit(itemAdded.create({ photo, duplicate }));
                },
                (message) => emit(itemFailed.create({ source, message })),
              );
            }
            if (!signal.aborted) emit(batchDone.create());
          })();
        },
      });
      const tally = (
        opts: { context: { get(): GalleryContext; set(c: GalleryContext): void } },
        change: (b: AddBatch) => Partial<AddBatch>,
        photos?: (current: Photo[]) => Photo[],
      ) => {
        const c = opts.context.get();
        opts.context.set({
          ...c,
          photos: photos ? photos(c.photos) : c.photos,
          batch: c.batch ? { ...c.batch, done: c.batch.done + 1, ...change(c.batch) } : c.batch,
        });
      };
      /** A photo is added to the top of the list, or counted as already in the album. */
      m.on(adding, {
        event: itemAdded,
        handler: (e, opts) => {
          const { photo, duplicate } = e.payload;
          tally(
            opts,
            (b) => (duplicate ? { duplicates: b.duplicates + 1 } : { added: b.added + 1 }),
            photo
              ? (current) => [photo, ...current.filter((p) => !samePhoto(p, photo))]
              : undefined,
          );
          return {};
        },
      });
      /** A photo failed to add: it is kept in the summary for retry and the rest carry on. */
      m.on(adding, {
        event: itemFailed,
        handler: (e, opts) => {
          tally(opts, (b) => ({ failed: [...b.failed, e.payload] }));
          return {};
        },
      });
      /** The album synced while loading: the photos reload once more afterwards. */
      m.on(loading, {
        event: load,
        handler: (_e, opts) => {
          opts.context.set({ ...opts.context.get(), reloadAfterAdd: true });
          return {};
        },
      });
      /** The album synced while photos are adding: the photos reload when adding ends. */
      m.on(adding, {
        event: load,
        handler: (_e, opts) => {
          opts.context.set({ ...opts.context.get(), reloadAfterAdd: true });
          return {};
        },
      });
      /** Adding ended: the summary shows the result and the photos reload if uploads or syncs need it. */
      m.on(adding, {
        event: batchDone,
        to: [loading, ready],
        handler: (_e, opts) => {
          const c = opts.context.get();
          // Uploads come back as bare ids: reload for the full photos.
          const uploaded = c.pendingAdd?.sources.some((s) => s.kind === "file") ?? false;
          opts.context.set(
            idleContext(c, { batch: c.batch ? { ...c.batch, running: false } : null }),
          );
          return { state: c.reloadAfterAdd || uploaded ? loading : ready };
        },
      });

      for (const at of [ready, couldNotRemovePhoto]) {
        /** The person removes a photo; the screen shows it is busy. */
        m.on(at, {
          event: remove,
          to: [removing],
          handler: (e, opts) => {
            opts.context.set(
              idleContext(opts.context.get(), { error: null, pendingRemove: { ...e.payload } }),
            );
            return { state: removing };
          },
        });
      }
      /** The photo is deleted from the album. */
      m.effect(removing, {
        name: "removing",
        sends: [removed, removeFailed],
        fn: ({ signal, emit, context }) => {
          const pending = context.get().pendingRemove;
          if (!pending) {
            emit(removeFailed.create({ message: "no pending photo to remove" }));
            return;
          }
          return runInvoke(
            signal,
            () => port.remove(pending.id, pending.folderId),
            () => emit(removed.create(pending)),
            (message) => emit(removeFailed.create({ message })),
          );
        },
      });
      /** The photo disappears from the list. */
      m.on(removing, {
        event: removed,
        to: [ready],
        handler: (e, opts) => {
          const c = opts.context.get();
          opts.context.set(
            idleContext(c, {
              error: null,
              photos: c.photos.filter((p) => !samePhoto(p, e.payload)),
            }),
          );
          return { state: ready };
        },
      });
      /** Removing failed: the photo stays and the person sees why. */
      m.on(removing, {
        event: removeFailed,
        to: [couldNotRemovePhoto],
        handler: (e, opts) => {
          opts.context.set(idleContext(opts.context.get(), { error: e.payload.message }));
          return { state: couldNotRemovePhoto };
        },
      });
    },
  });
}

export type GalleryActor = ReturnType<typeof createGalleryActor>;

export const galleryActor = createGalleryActor({ clock: RealClock() });

export const gallery = {
  state: () => nameOf(galleryActor.snapshot()),
  load: () => galleryActor.send(load.create()),
  add: (path: string, name?: string, folderId?: string) =>
    galleryActor.send(addMany.create({ sources: [{ kind: "path", path, name }], folderId })),
  /** Adds photos to one album, in order, with progress in `context.batch`. */
  addMany: (sources: AddSource[], folderId?: string) =>
    galleryActor.send(addMany.create({ sources, folderId })),
  retryFailed: () => galleryActor.send(retryFailed.create()),
  dismissBatch: () => galleryActor.send(dismissBatch.create()),
  remove: (id: string, folderId?: string) => galleryActor.send(remove.create({ id, folderId })),
  retry: () => galleryActor.send(retry.create()),
  /** The backend pushed a photos change at `at`. */
  synced: (at: number) => galleryActor.send(synced.create({ at })),
};
