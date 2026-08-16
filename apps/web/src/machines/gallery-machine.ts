import { Actor, RealClock, event, state } from "@mantaq/core";
import { atom, computed } from "nanostores";
import type { Photo } from "@justus/core";
import { gateway } from "../gateway";
import { $syncStatus } from "./sync-machine";
import { bindStateAtoms, runInvoke } from "./actor-utils";

/**
 * The gallery state machine. All gallery state lives here (a mantaq actor);
 * its context holds the in-flight add/remove ids the effects read. The shell
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
    role: status?.role ?? null,
  }),
);

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
  pendingAdd: string | null;
  pendingRemove: string | null;
};

const galleryActor = new Actor({
  inputs: [load, add, remove, retry],
  internal: [loaded, loadFailed, added, addFailed, removed, removeFailed],
  outputs: [],
  states: [booting, loading, ready, error, adding, removing],
  initial: booting,
  clock: new RealClock(),
  context: {
    pendingAdd: null,
    pendingRemove: null,
  } as GalleryContext,
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
      opts.context.set({ pendingAdd: null, pendingRemove: null });
      return { state: ready };
    });
    m.on(loading, loadFailed, (e, opts) => {
      $galleryError.set(e.payload.message);
      opts.context.set({ pendingAdd: null, pendingRemove: null });
      return { state: error };
    });

    m.on(ready, add, (e, opts) => {
      $galleryError.set(null);
      opts.context.set({ pendingAdd: e.payload.path, pendingRemove: null });
      return { state: adding };
    });
    m.effect(adding, ({ signal, emit, context }) => {
      const path = context.get().pendingAdd;
      if (!path) {
        emit(addFailed.create({ message: "no pending photo to add" }));
        return;
      }
      return runInvoke(
        signal,
        () => gateway.add(path),
        (result) =>
          result
            ? emit(added.create({ photo: result as Photo }))
            : emit(addFailed.create({ message: "add returned no photo" })),
        (message) => emit(addFailed.create({ message })),
      );
    });
    m.on(adding, added, (e, opts) => {
      $galleryError.set(null);
      $photos.set([e.payload.photo, ...$photos.get().filter((p) => p.id !== e.payload.photo.id)]);
      opts.context.set({ pendingAdd: null, pendingRemove: null });
      return { state: ready };
    });
    m.on(adding, addFailed, (e, opts) => {
      $galleryError.set(e.payload.message);
      opts.context.set({ pendingAdd: null, pendingRemove: null });
      return { state: ready };
    });

    m.on(ready, remove, (e, opts) => {
      $galleryError.set(null);
      opts.context.set({ pendingRemove: e.payload.id, pendingAdd: null });
      return { state: removing };
    });
    m.effect(removing, ({ signal, emit, context }) => {
      const id = context.get().pendingRemove;
      if (!id) {
        emit(removeFailed.create({ message: "no pending photo to remove" }));
        return;
      }
      return runInvoke(
        signal,
        () => gateway.remove(id),
        () => emit(removed.create({ id })),
        (message) => emit(removeFailed.create({ message })),
      );
    });
    m.on(removing, removed, (e, opts) => {
      $galleryError.set(null);
      $photos.set($photos.get().filter((p) => p.id !== e.payload.id));
      opts.context.set({ pendingAdd: null, pendingRemove: null });
      return { state: ready };
    });
    m.on(removing, removeFailed, (e, opts) => {
      $galleryError.set(e.payload.message);
      opts.context.set({ pendingAdd: null, pendingRemove: null });
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
  add: (path: string) => galleryActor.send(add.create({ path })),
  remove: (id: string) => galleryActor.send(remove.create({ id })),
  retry: () => galleryActor.send(retry.create()),
};
