import { Actor, RealClock, event, state } from "@mantaq/core";
import { atom, computed } from "nanostores";
import type { Photo } from "@justus/core";
import { gateway } from "../gateway";
import { $syncStatus } from "./sync-machine";
import { bindStateAtoms, runInvoke } from "./actor-utils";

/**
 * The gallery state machine. All gallery state lives here (a mantaq actor);
 * its context holds the in-flight add batch / remove id the effects read. The shell
 * (gateway) performs plugin invokes; this actor owns the flow. Every invoke
 * is wrapped so a transport failure surfaces as a modeled failure event —
 * never an unhandled rejection (which would wedge the machine in `busy`).
 */

const GALLERY_STATES = ["booting", "loading", "ready", "error", "adding", "removing"] as const;
export type GalleryStateName = (typeof GALLERY_STATES)[number];

export const $photos = atom<Photo[]>([]);
export const $galleryState = atom<GalleryStateName>("booting");
export const $galleryError = atom<string | null>(null);
/** True only for mantaq's universal `__error`: the machine is dead and Retry
 * cannot help — the UI must offer a reload instead. */
export const $galleryFatal = atom(false);
/** Set on every backend `photos.changed` push — feeds the "last synced" hint. */
export const $lastSyncAt = atom<number | null>(null);

/** One photo to add: a file the native host staged (`path`), or a file the
 * browser picked (bytes posted to the worklet's upload route). */
export type AddSource =
  | { kind: "path"; path: string; name?: string }
  | { kind: "file"; file: File };

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

/** The add batch in flight, or the last one until it is dismissed (a batch
 * with failures stays up so the user can retry them). */
export const $addBatch = atom<AddBatch | null>(null);

/** Plain view model for the gallery UI (directives cannot be dereferenced —
 * this maps the atoms to a value a template can read). `busy` is derived:
 * it is exactly "an add or remove is in flight". `role` comes from the sync
 * machine's status so the empty state can be reader-aware. */
export const $galleryViewModel = computed(
  [$galleryState, $galleryError, $galleryFatal, $photos, $syncStatus],
  (state, error, fatal, photos, status) => ({
    state,
    busy: state === "adding" || state === "removing",
    error,
    fatal,
    photos,
    role: status?.folder?.role ?? null,
  }),
);

/** Photo ids are only unique within an album; the list spans all of them. */
export function samePhoto(
  a: { id: string; folderId?: string },
  b: { id: string; folderId?: string },
): boolean {
  return a.id === b.id && a.folderId === b.folderId;
}

const booting = state("booting")();
const loading = state("loading")();
const ready = state("ready")();
const error = state("error")();
const adding = state("adding")();
const removing = state("removing")();

const load = event("LOAD")();
const loaded = event("LOADED")<{ photos: Photo[] }>();
const loadFailed = event("LOAD_FAILED")<{ message: string }>();
const addMany = event("ADD_MANY")<{ sources: AddSource[]; folderId?: string }>();
const itemAdded = event("ITEM_ADDED")<{ photo: Photo | null; duplicate: boolean }>();
const itemFailed = event("ITEM_FAILED")<{ source: AddSource; message: string }>();
const batchDone = event("BATCH_DONE")();
const retryFailed = event("RETRY_FAILED")();
const dismissBatch = event("DISMISS_BATCH")();
const remove = event("REMOVE")<{ id: string; folderId?: string }>();
const removed = event("REMOVED")<{ id: string; folderId?: string }>();
const removeFailed = event("REMOVE_FAILED")<{ message: string }>();
const retry = event("RETRY")();

type GalleryContext = {
  pendingAdd: { sources: AddSource[]; folderId?: string } | null;
  pendingRemove: { id: string; folderId?: string } | null;
  /** A `photos.changed` push arrived mid-batch or mid-load: reload once the
   * batch or the in-flight list ends, so nothing is missed. */
  reloadAfterAdd: boolean;
};

const idleContext = (): GalleryContext => ({
  pendingAdd: null,
  pendingRemove: null,
  reloadAfterAdd: false,
});

/** Adds one photo. A browser upload answers with only an id; the push it
 * triggers brings the full photo in on the reload after the batch. */
function addOne(source: AddSource, folderId?: string): Promise<[unknown, unknown]> {
  return source.kind === "path"
    ? gateway.add(source.path, source.name, folderId)
    : gateway.upload(source.file, folderId);
}

const galleryActor = new Actor({
  inputs: [load, addMany, remove, retry, retryFailed, dismissBatch],
  internal: [loaded, loadFailed, itemAdded, itemFailed, batchDone, removed, removeFailed],
  outputs: [],
  states: [booting, loading, ready, error, adding, removing],
  initial: booting,
  clock: new RealClock(),
  context: idleContext(),
  setup: (m) => {
    m.on(booting, load, () => {
      $galleryError.set(null);
      return { state: loading };
    });
    m.on(ready, load, () => {
      $galleryError.set(null);
      return { state: loading };
    });
    m.on(error, load, () => {
      $galleryError.set(null);
      return { state: loading };
    });
    m.on(error, retry, () => {
      $galleryError.set(null);
      return { state: loading };
    });

    m.effect(loading, ({ signal, emit }) => {
      return runInvoke(
        signal,
        () => gateway.list(),
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
    });

    m.on(loading, loaded, (e, opts) => {
      $photos.set(e.payload.photos);
      $galleryError.set(null);
      // Photos picked while the list was loading start adding now.
      if (opts.context.get().pendingAdd) return { state: adding };
      // A push during the load may name photos this list predates.
      const again = opts.context.get().reloadAfterAdd;
      opts.context.set(idleContext());
      return { state: again ? loading : ready };
    });
    m.on(loading, loadFailed, (e, opts) => {
      $galleryError.set(e.payload.message);
      if (opts.context.get().pendingAdd) return { state: adding };
      opts.context.set(idleContext());
      return { state: error };
    });

    const queueBatch = (
      sources: AddSource[],
      folderId: string | undefined,
      opts: { context: { set(c: GalleryContext): void } },
    ) => {
      $addBatch.set({
        folderId,
        total: sources.length,
        done: 0,
        added: 0,
        duplicates: 0,
        failed: [],
        running: true,
      });
      opts.context.set({ ...idleContext(), pendingAdd: { sources, folderId } });
    };
    const startBatch = (
      sources: AddSource[],
      folderId: string | undefined,
      opts: { context: { set(c: GalleryContext): void } },
    ) => {
      $galleryError.set(null);
      queueBatch(sources, folderId, opts);
      return { state: adding };
    };
    m.on(ready, addMany, (e, opts) => startBatch(e.payload.sources, e.payload.folderId, opts));
    // A `photos.changed` push reloads the list often (every sync). Photos
    // picked meanwhile must not be dropped: queue them, shown as adding, and
    // start once the list is in.
    for (const at of [booting, loading]) {
      m.on(at, addMany, (e, opts) => {
        if (opts.context.get().pendingAdd) return {};
        queueBatch(e.payload.sources, e.payload.folderId, opts);
        return {};
      });
    }
    m.on(ready, retryFailed, (_e, opts) => {
      const last = $addBatch.get();
      if (!last || last.running || last.failed.length === 0) return {};
      return startBatch(
        last.failed.map((f) => f.source),
        last.folderId,
        opts,
      );
    });
    // A finished batch can be dismissed whatever the gallery is doing (an
    // upload batch ends in a reload); only the running one stays.
    for (const at of [booting, loading, ready, error, removing]) {
      m.on(at, dismissBatch, () => {
        if (!$addBatch.get()?.running) $addBatch.set(null);
        return {};
      });
    }
    // One photo at a time: the worklet writes each to the album's drive in
    // turn, and the progress count stays honest.
    m.effect(adding, ({ signal, emit, context }) => {
      const batch = context.get().pendingAdd;
      if (!batch || batch.sources.length === 0) {
        emit(batchDone.create());
        return;
      }
      // Ids already in the album, to tell a deduped re-add from a new photo.
      const key = (id: string, folderId?: string) => `${folderId ?? ""}/${id}`;
      const held = new Set($photos.get().map((p) => key(p.id, p.folderId)));
      return (async () => {
        for (const source of batch.sources) {
          if (signal.aborted) return;
          await runInvoke(
            signal,
            () => addOne(source, batch.folderId),
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
    });
    const tally = (change: (b: AddBatch) => Partial<AddBatch>) => {
      const b = $addBatch.get();
      if (b) $addBatch.set({ ...b, done: b.done + 1, ...change(b) });
    };
    m.on(adding, itemAdded, (e) => {
      const { photo, duplicate } = e.payload;
      if (photo) $photos.set([photo, ...$photos.get().filter((p) => !samePhoto(p, photo))]);
      tally((b) => (duplicate ? { duplicates: b.duplicates + 1 } : { added: b.added + 1 }));
      return {};
    });
    m.on(adding, itemFailed, (e) => {
      tally((b) => ({ failed: [...b.failed, e.payload] }));
      return {};
    });
    m.on(loading, load, (_e, opts) => {
      opts.context.set({ ...opts.context.get(), reloadAfterAdd: true });
      return {};
    });
    m.on(adding, load, (_e, opts) => {
      opts.context.set({ ...opts.context.get(), reloadAfterAdd: true });
      return {};
    });
    m.on(adding, batchDone, (_e, opts) => {
      const { reloadAfterAdd, pendingAdd } = opts.context.get();
      const b = $addBatch.get();
      if (b) $addBatch.set({ ...b, running: false });
      // Uploads come back as bare ids: reload for the full photos.
      const uploaded = pendingAdd?.sources.some((s) => s.kind === "file") ?? false;
      opts.context.set(idleContext());
      return { state: reloadAfterAdd || uploaded ? loading : ready };
    });

    m.on(ready, remove, (e, opts) => {
      $galleryError.set(null);
      opts.context.set({ ...idleContext(), pendingRemove: { ...e.payload } });
      return { state: removing };
    });
    m.effect(removing, ({ signal, emit, context }) => {
      const pending = context.get().pendingRemove;
      if (!pending) {
        emit(removeFailed.create({ message: "no pending photo to remove" }));
        return;
      }
      return runInvoke(
        signal,
        () => gateway.remove(pending.id, pending.folderId),
        () => emit(removed.create(pending)),
        (message) => emit(removeFailed.create({ message })),
      );
    });
    m.on(removing, removed, (e, opts) => {
      $galleryError.set(null);
      $photos.set($photos.get().filter((p) => !samePhoto(p, e.payload)));
      opts.context.set(idleContext());
      return { state: ready };
    });
    m.on(removing, removeFailed, (e, opts) => {
      $galleryError.set(e.payload.message);
      opts.context.set(idleContext());
      return { state: ready };
    });
  },
});

const { state: stateName } = bindStateAtoms({
  actor: galleryActor,
  states: GALLERY_STATES,
  $state: $galleryState,
  $error: $galleryError,
  $fatal: $galleryFatal,
});

export const gallery = {
  state: stateName,
  load: () => galleryActor.send(load.create()),
  add: (path: string, name?: string, folderId?: string) =>
    galleryActor.send(addMany.create({ sources: [{ kind: "path", path, name }], folderId })),
  /** Adds photos to one album, in order, with progress in `$addBatch`. */
  addMany: (sources: AddSource[], folderId?: string) =>
    galleryActor.send(addMany.create({ sources, folderId })),
  retryFailed: () => galleryActor.send(retryFailed.create()),
  dismissBatch: () => galleryActor.send(dismissBatch.create()),
  remove: (id: string, folderId?: string) => galleryActor.send(remove.create({ id, folderId })),
  retry: () => galleryActor.send(retry.create()),
};
