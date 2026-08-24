import { Actor, RealClock, event, state } from "@mantaq/core";
import { atom, computed } from "nanostores";
import { bindStateAtoms } from "./actor-utils";

/**
 * Local albums — the user's own curation layer on top of a Folder's synced
 * photos (vision: "albums are how one person groups them"). Albums are local
 * organization only (no p2p replication), so the whole machine is pure local
 * state + best-effort `localStorage` persistence: no backend invoke, fully
 * unit-testable. A future slice can teach the backend to replicate an album
 * across a user's own devices.
 */

export type Album = {
  /** Stable local id. */
  id: string;
  name: string;
  /** Photo ids (Folder-drive file ids) that belong to this album. */
  photoIds: string[];
};

const STORAGE_KEY = "justus:albums";

const ALBUM_STATES = ["idle", "creating", "renaming", "removing", "ready", "error"] as const;
export type AlbumStateName = (typeof ALBUM_STATES)[number];

export const $albums = atom<Album[]>([]);
export const $activeAlbumId = atom<string | null>(null);
export const $albumsState = atom<AlbumStateName>("idle");
export const $albumsError = atom<string | null>(null);
export const $albumsFatal = atom(false);
/** When true the active album's panel shows the folder's photos as a
 * multi-select to add/remove members (instead of the album's own grid). */
export const $albumAddMode = atom(false);

export const $albumsViewModel = computed(
  [$albums, $activeAlbumId, $albumsState, $albumsError, $albumsFatal, $albumAddMode],
  (albums, activeId, stateName, error, fatal, addMode) => ({
    albums,
    active: albums.find((a) => a.id === activeId) ?? null,
    activeId,
    state: stateName,
    error,
    fatal,
    addMode,
  }),
);

// --- persistence -----------------------------------------------------------

function isAlbum(value: unknown): value is Album {
  if (typeof value !== "object" || value === null) return false;
  const a = value as Record<string, unknown>;
  return (
    typeof a.id === "string" &&
    typeof a.name === "string" &&
    Array.isArray(a.photoIds) &&
    a.photoIds.every((p) => typeof p === "string")
  );
}

/** Read persisted albums. Best-effort: returns [] without storage. */
export function loadAlbums(): Album[] {
  try {
    if (typeof localStorage === "undefined") return [];
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isAlbum);
  } catch {
    return [];
  }
}

/** Persist albums. Best-effort: no-op without storage. */
export function saveAlbums(albums: Album[]): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(albums));
  } catch {
    // storage unavailable (private mode / non-browser) — ignore
  }
}

function genId(): string {
  try {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  } catch {
    // fall through to fallback
  }
  return `album-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// --- machine ---------------------------------------------------------------

const idle = state("idle")();
const creating = state("creating")();
const renaming = state("renaming")();
const removing = state("removing")();
const ready = state("ready")();
const error = state("error")();

const create = event("CREATE")<{ name: string }>();
const rename = event("RENAME")<{ id: string; name: string }>();
const remove = event("REMOVE")<{ id: string }>();
const open = event("OPEN")<{ id: string }>();
const addPhotos = event("ADD_PHOTOS")<{ ids: string[] }>();
const removePhoto = event("REMOVE_PHOTO")<{ id: string }>();
// `removePhoto` carries the album id so it is unambiguous even when no album
// is "active" in the UI; wired to the active album in the handler below.

type AlbumContext = {
  albums: Album[];
  activeId: string | null;
};

const seeded = loadAlbums();
$albums.set(seeded);

const albumsActor = new Actor({
  inputs: [create, rename, remove, open, addPhotos, removePhoto],
  internal: [],
  outputs: [],
  states: [idle, creating, renaming, removing, ready, error],
  initial: idle,
  clock: new RealClock(),
  context: { albums: seeded, activeId: null } as AlbumContext,
  setup: (m) => {
    const valid = [idle, ready, error] as const;

    valid.forEach((s) => {
      m.on(s, create, (e, opts) => {
        const name = (e.payload.name ?? "").trim();
        if (!name) {
          $albumsError.set("Album name can't be empty.");
          return { state: error };
        }
        const album: Album = { id: genId(), name, photoIds: [] };
        const albums = [...opts.context.get().albums, album];
        opts.context.set({ albums, activeId: album.id });
        $albums.set(albums);
        $activeAlbumId.set(album.id);
        saveAlbums(albums);
        return { state: ready };
      });

      m.on(s, rename, (e, opts) => {
        const name = (e.payload.name ?? "").trim();
        if (!name) {
          $albumsError.set("Album name can't be empty.");
          return { state: error };
        }
        const albums = opts.context
          .get()
          .albums.map((a) => (a.id === e.payload.id ? { ...a, name } : a));
        opts.context.set({ ...opts.context.get(), albums });
        $albums.set(albums);
        saveAlbums(albums);
        return { state: ready };
      });

      m.on(s, remove, (e, opts) => {
        const albums = opts.context.get().albums.filter((a) => a.id !== e.payload.id);
        const prev = opts.context.get();
        const activeId = prev.activeId === e.payload.id ? null : prev.activeId;
        opts.context.set({ albums, activeId });
        $albums.set(albums);
        $activeAlbumId.set(activeId);
        saveAlbums(albums);
        return { state: ready };
      });

      m.on(s, open, (e, opts) => {
        opts.context.set({ ...opts.context.get(), activeId: e.payload.id });
        $activeAlbumId.set(e.payload.id);
        $albumAddMode.set(false);
        return { state: ready };
      });

      m.on(s, addPhotos, (e, opts) => {
        const activeId = opts.context.get().activeId;
        if (!activeId) {
          $albumsError.set("Open an album first.");
          return { state: error };
        }
        const albums = opts.context.get().albums.map((a) => {
          if (a.id !== activeId) return a;
          const set = new Set(a.photoIds);
          e.payload.ids.forEach((id) => set.add(id));
          return { ...a, photoIds: [...set] };
        });
        opts.context.set({ ...opts.context.get(), albums });
        $albums.set(albums);
        saveAlbums(albums);
        return { state: ready };
      });

      m.on(s, removePhoto, (e, opts) => {
        const activeId = opts.context.get().activeId;
        if (!activeId) {
          $albumsError.set("Open an album first.");
          return { state: error };
        }
        const albums = opts.context
          .get()
          .albums.map((a) =>
            a.id === activeId
              ? { ...a, photoIds: a.photoIds.filter((p) => p !== e.payload.id) }
              : a,
          );
        opts.context.set({ ...opts.context.get(), albums });
        $albums.set(albums);
        saveAlbums(albums);
        return { state: ready };
      });
    });
  },
});

const { state: stateName } = bindStateAtoms({
  actor: albumsActor,
  states: ALBUM_STATES,
  $state: $albumsState,
  $error: $albumsError,
  $fatal: $albumsFatal,
});

export const albums = {
  state: stateName,
  create: (name: string) => albumsActor.send(create.create({ name })),
  rename: (id: string, name: string) => albumsActor.send(rename.create({ id, name })),
  remove: (id: string) => albumsActor.send(remove.create({ id })),
  open: (id: string) => albumsActor.send(open.create({ id })),
  addPhotos: (ids: string[]) => albumsActor.send(addPhotos.create({ ids })),
  removePhoto: (photoId: string) => albumsActor.send(removePhoto.create({ id: photoId })),
  toggleAddMode: () => $albumAddMode.set(!$albumAddMode.get()),
};
