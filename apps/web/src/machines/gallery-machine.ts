import { Actor, RealClock, event, state, type Snapshot } from "@mantaq/core";
import { atom } from "nanostores";
import type { Photo } from "@justus/core";
import { gateway } from "../gateway";

/**
 * The gallery state machine. All gallery state lives here (a mantaq actor);
 * its context holds nanostore atoms the UI reads reactively. The shell
 * (gateway) performs plugin invokes; this actor owns the flow. Every invoke
 * is wrapped so a transport failure surfaces as a modeled failure event —
 * never an unhandled rejection (which would wedge the machine in `busy`).
 */

export type GalleryStateName = "booting" | "loading" | "ready" | "error" | "adding" | "removing";

const STATE_NAMES: ReadonlySet<string> = new Set([
  "booting",
  "loading",
  "ready",
  "error",
  "adding",
  "removing",
]);

export const $photos = atom<Photo[]>([]);
export const $galleryState = atom<GalleryStateName>("booting");
export const $galleryBusy = atom<boolean>(false);
export const $galleryError = atom<string | null>(null);

const booting = state("booting")();
const loading = state("loading")();
const ready = state("ready")();
const error = state("error")();
const adding = state("adding")();
const removing = state("removing")();

const load = event("LOAD")();
const loaded = event("LOADED")<{ photos: Photo[] }>();
const loadFailed = event("LOAD_FAILED")<{ message: string }>();
const add = event("ADD")<{ path: string }>();
const added = event("ADDED")<{ photo: Photo }>();
const addFailed = event("ADD_FAILED")<{ message: string }>();
const remove = event("REMOVE")<{ id: string }>();
const removed = event("REMOVED")<{ id: string }>();
const removeFailed = event("REMOVE_FAILED")<{ message: string }>();
const retry = event("RETRY")();

type GalleryContext = {
  $photos: typeof $photos;
  $busy: typeof $galleryBusy;
  $error: typeof $galleryError;
  pendingAdd: string | null;
  pendingRemove: string | null;
};

/** Safe runner for an async invoke inside an effect: models rejections as
 * failure events instead of unhandled rejections. */
function runInvoke(
  signal: AbortSignal,
  work: () => Promise<[unknown, unknown]>,
  onSuccess: (result: unknown) => void,
  onFailure: (message: string) => void,
) {
  void (async () => {
    let outcome: [unknown, unknown];
    try {
      outcome = await work();
    } catch (e) {
      if (signal.aborted) return;
      onFailure(e instanceof Error ? e.message : String(e));
      return;
    }
    if (signal.aborted) return;
    const [err, result] = outcome;
    if (err) onFailure(err instanceof Error ? err.message : "unknown error");
    else onSuccess(result);
  })();
}

const galleryActor = new Actor({
  inputs: [load, add, remove, retry],
  internal: [loaded, loadFailed, added, addFailed, removed, removeFailed],
  outputs: [],
  states: [booting, loading, ready, error, adding, removing],
  initial: booting,
  clock: new RealClock(),
  context: {
    $photos,
    $busy: $galleryBusy,
    $error: $galleryError,
    pendingAdd: null,
    pendingRemove: null,
  } as GalleryContext,
  setup: (m) => {
    m.on(booting, load, () => ({ state: loading }));
    m.on(ready, load, () => ({ state: loading }));
    m.on(error, load, () => ({ state: loading }));
    m.on(error, retry, () => ({ state: loading }));

    m.effect(loading, ({ signal, emit }) => {
      runInvoke(
        signal,
        () => gateway.list(),
        (result) => emit(loaded.create({ photos: (result as { photos?: Photo[] })?.photos ?? [] })),
        (message) => emit(loadFailed.create({ message })),
      );
    });

    m.on(loading, loaded, (e, opts) => {
      const s = opts.context.get();
      s.$photos.set(e.payload.photos);
      s.$error.set(null);
      return { state: ready };
    });
    m.on(loading, loadFailed, (e, opts) => {
      opts.context.get().$error.set(e.payload.message);
      return { state: error };
    });

    m.on(ready, add, (e, opts) => {
      const s = opts.context.get();
      s.$busy.set(true);
      s.$error.set(null);
      opts.context.set({ ...s, pendingAdd: e.payload.path });
      return { state: adding };
    });
    m.effect(adding, ({ signal, emit, context }) => {
      const path = context.get().pendingAdd;
      if (!path) {
        emit(addFailed.create({ message: "no pending photo to add" }));
        return;
      }
      runInvoke(
        signal,
        () => gateway.add(path),
        (result) => emit(added.create({ photo: result as Photo })),
        (message) => emit(addFailed.create({ message })),
      );
    });
    m.on(adding, added, (e, opts) => {
      const s = opts.context.get();
      s.$busy.set(false);
      s.$error.set(null);
      s.$photos.set([
        e.payload.photo,
        ...s.$photos.get().filter((p) => p.id !== e.payload.photo.id),
      ]);
      opts.context.set({ ...s, pendingAdd: null });
      return { state: ready };
    });
    m.on(adding, addFailed, (e, opts) => {
      const s = opts.context.get();
      s.$busy.set(false);
      s.$error.set(e.payload.message);
      opts.context.set({ ...s, pendingAdd: null });
      return { state: ready };
    });

    m.on(ready, remove, (e, opts) => {
      const s = opts.context.get();
      s.$busy.set(true);
      s.$error.set(null);
      opts.context.set({ ...s, pendingRemove: e.payload.id });
      return { state: removing };
    });
    m.effect(removing, ({ signal, emit, context }) => {
      const id = context.get().pendingRemove;
      if (!id) {
        emit(removeFailed.create({ message: "no pending photo to remove" }));
        return;
      }
      runInvoke(
        signal,
        () => gateway.remove(id),
        () => emit(removed.create({ id })),
        (message) => emit(removeFailed.create({ message })),
      );
    });
    m.on(removing, removed, (e, opts) => {
      const s = opts.context.get();
      s.$busy.set(false);
      s.$error.set(null);
      s.$photos.set(s.$photos.get().filter((p) => p.id !== e.payload.id));
      opts.context.set({ ...s, pendingRemove: null });
      return { state: ready };
    });
    m.on(removing, removeFailed, (e, opts) => {
      const s = opts.context.get();
      s.$busy.set(false);
      s.$error.set(e.payload.message);
      opts.context.set({ ...s, pendingRemove: null });
      return { state: ready };
    });
  },
});

const nameOf = (snapshot: Snapshot<GalleryContext>) => {
  const name = snapshot.path[0] as string;
  return (STATE_NAMES.has(name) ? name : "error") as GalleryStateName;
};

galleryActor.on("change", (snapshot) => {
  $galleryState.set(nameOf(snapshot));
});

export const gallery = {
  state: () => nameOf(galleryActor.snapshot()),
  load: () => galleryActor.send(load.create()),
  add: (path: string) => galleryActor.send(add.create({ path })),
  remove: (id: string) => galleryActor.send(remove.create({ id })),
  retry: () => galleryActor.send(retry.create()),
};
