import { Actor, RealClock, event, state } from "@mantaq/core";
import { atom, computed } from "nanostores";
import type { FolderSummary, SyncStatus } from "@justus/core";
import { gateway } from "../gateway";
import { bindStateAtoms, runInvoke } from "./actor-utils";
import { $syncStatus } from "./sync-machine";

/**
 * Folder management: the device's user name, its folder list, and the active
 * folder it is showing. Same actor pattern as the gallery/sync machines — the
 * context holds the in-flight create/rename targets the effects read.
 */

const FOLDERS_STATES = [
  "idle",
  "refreshing",
  "ok",
  "creating",
  "switching",
  "renaming",
  "error",
] as const;
export type FoldersStateName = (typeof FOLDERS_STATES)[number];

export const $userName = atom<string>("");
export const $folders = atom<FolderSummary[]>([]);
export const $activeFolderId = atom<string | null>(null);
export const $foldersState = atom<FoldersStateName>("idle");
export const $foldersError = atom<string | null>(null);
export const $foldersFatal = atom(false);

export const $foldersViewModel = computed(
  [$userName, $folders, $activeFolderId, $foldersState, $foldersError, $foldersFatal],
  (userName, folders, activeFolderId, state, error, fatal) => ({
    userName,
    folders,
    activeFolderId,
    state,
    busy: state === "creating" || state === "switching" || state === "renaming",
    error,
    fatal,
  }),
);

// The user name lives on the backend (device.json); status is the source of
// truth for it, so keep the atom in step whenever the active folder reports.
$syncStatus.listen((status) => {
  if (status?.name) $userName.set(status.name);
});

/** Albums have not been loaded yet. */
const idle = state("idle")();
/** The album list is loading. */
const refreshing = state("refreshing")();
/** The albums are listed and one is open. */
const ok = state("ok")();
/** A new album is being created. */
const creating = state("creating")();
/** The person is moving to another album. */
const switching = state("switching")();
/** The person's name is being changed. */
const renaming = state("renaming")();
/** The albums could not be loaded; the person can try again. */
const error = state("error")();

/** The app asks for the latest list of albums. */
const refresh = event("REFRESH")();
/** The album list arrived. */
const loaded = event("LOADED")<{
  name: string;
  folders: FolderSummary[];
  activeId: string | null;
}>();
/** The album list could not be loaded. */
const loadFailed = event("LOAD_FAILED")<{ message: string }>();
/** The person names and creates a new album. */
const createFolder = event("CREATE_FOLDER")<{ name: string }>();
/** The new album was created. */
const created = event("CREATED")<{ folder: FolderSummary }>();
/** The album could not be created. */
const createFailed = event("CREATE_FAILED")<{ message: string }>();
/** The person opens a different album. */
const setActive = event("SET_ACTIVE")<{ folderId: string }>();
/** The other album is now open. */
const switched = event("SWITCHED")<{ status: SyncStatus }>();
/** The other album could not be opened. */
const switchFailed = event("SWITCH_FAILED")<{ message: string }>();
/** The person changes the name others see. */
const setName = event("SET_NAME")<{ name: string }>();
/** The new name was saved. */
const renamed = event("RENAMED")<{ name: string }>();
/** The new name could not be saved. */
const renameFailed = event("RENAME_FAILED")<{ message: string }>();
/** The person taps Try again after an error. */
const retry = event("RETRY")();

type FoldersContext = {
  pendingCreate: string | null;
  pendingActive: string | null;
  pendingName: string | null;
};

export const foldersActor = Actor({
  inputs: [refresh, createFolder, setActive, setName, retry],
  internal: [
    loaded,
    loadFailed,
    created,
    createFailed,
    switched,
    switchFailed,
    renamed,
    renameFailed,
  ],
  outputs: [],
  states: [idle, refreshing, ok, creating, switching, renaming, error],
  initial: idle,
  clock: RealClock(),
  context: {
    pendingCreate: null,
    pendingActive: null,
    pendingName: null,
  } as FoldersContext,
  setup: (m) => {
    /** First load of albums starts and any error is cleared. */
    m.on(idle, {
      event: refresh,
      to: [refreshing],
      handler: () => {
        $foldersError.set(null);
        return { state: refreshing };
      },
    });
    /** Refreshing the albums starts a reload and clears any error. */
    m.on(ok, {
      event: refresh,
      to: [refreshing],
      handler: () => {
        $foldersError.set(null);
        return { state: refreshing };
      },
    });
    /** After an error, refreshing starts a reload and clears the error. */
    m.on(error, {
      event: refresh,
      to: [refreshing],
      handler: () => {
        $foldersError.set(null);
        return { state: refreshing };
      },
    });
    /** Try again after an error reloads the albums. */
    m.on(error, {
      event: retry,
      to: [refreshing],
      handler: () => {
        $foldersError.set(null);
        return { state: refreshing };
      },
    });

    /** The albums are fetched from the app's storage. */
    m.effect(refreshing, {
      name: "refreshing",
      fn: ({ signal, emit }) => {
        return runInvoke(
          signal,
          () => gateway.folders(),
          (result) => {
            const r = result as { folders?: FolderSummary[]; activeFolderId?: string } | null;
            // `activeFolderId` may legitimately be null (a fresh device with no
            // folder chosen yet) — only a missing folder list is a real load
            // failure. Treating null as an error wedged first-run users on the
            // error screen instead of the empty gallery.
            if (!r?.folders) {
              emit(loadFailed.create({ message: "albums returned no data" }));
              return;
            }
            emit(
              loaded.create({
                name: $userName.get(),
                folders: r.folders,
                activeId: r.activeFolderId ?? null,
              }),
            );
          },
          (message) => emit(loadFailed.create({ message })),
        );
      },
    });
    /** The albums are listed and the active album is marked; an empty first-run device with no album chosen is fine. */
    m.on(refreshing, {
      event: loaded,
      to: [ok],
      handler: (e) => {
        $folders.set(e.payload.folders);
        $activeFolderId.set(e.payload.activeId);
        $foldersError.set(null);
        return { state: ok };
      },
    });
    /** Loading failed: an error is shown with a way to try again. */
    m.on(refreshing, {
      event: loadFailed,
      to: [error],
      handler: (e) => {
        $foldersError.set(e.payload.message);
        return { state: error };
      },
    });

    /** The person starts creating an album; the screen shows it is busy. */
    m.on(ok, {
      event: createFolder,
      to: [creating],
      handler: (e, opts) => {
        $foldersError.set(null);
        opts.context.set({ pendingCreate: e.payload.name, pendingActive: null, pendingName: null });
        return { state: creating };
      },
    });
    /** The new album is created. */
    m.effect(creating, {
      name: "creating",
      fn: ({ signal, emit, context }) => {
        const name = context.get().pendingCreate;
        if (!name) {
          emit(createFailed.create({ message: "no album name" }));
          return;
        }
        return runInvoke(
          signal,
          () => gateway.createFolder(name),
          (result) =>
            result
              ? emit(created.create({ folder: (result as { folder: FolderSummary }).folder }))
              : emit(createFailed.create({ message: "create returned no album" })),
          (message) => emit(createFailed.create({ message })),
        );
      },
    });
    /** The new album appears first in the list and is opened. */
    m.on(creating, {
      event: created,
      to: [ok],
      handler: (e, opts) => {
        $foldersError.set(null);
        $folders.set([e.payload.folder, ...$folders.get()]);
        $activeFolderId.set(e.payload.folder.id);
        opts.context.set({ pendingCreate: null, pendingActive: null, pendingName: null });
        return { state: ok };
      },
    });
    /** Creating failed: the list is unchanged and the person sees why. */
    m.on(creating, {
      event: createFailed,
      to: [ok],
      handler: (e, opts) => {
        $foldersError.set(e.payload.message);
        opts.context.set({ pendingCreate: null, pendingActive: null, pendingName: null });
        return { state: ok };
      },
    });

    /** The person picks another album; the screen shows it is busy. */
    m.on(ok, {
      event: setActive,
      to: [switching],
      handler: (e, opts) => {
        $foldersError.set(null);
        opts.context.set({
          pendingActive: e.payload.folderId,
          pendingCreate: null,
          pendingName: null,
        });
        return { state: switching };
      },
    });
    /** The chosen album is opened. */
    m.effect(switching, {
      name: "switching",
      fn: ({ signal, emit, context }) => {
        const folderId = context.get().pendingActive;
        if (!folderId) {
          emit(switchFailed.create({ message: "no album to switch to" }));
          return;
        }
        return runInvoke(
          signal,
          () => gateway.setActive(folderId),
          (result) =>
            result
              ? emit(switched.create({ status: result as SyncStatus }))
              : emit(switchFailed.create({ message: "switch returned no status" })),
          (message) => emit(switchFailed.create({ message })),
        );
      },
    });
    /** The picked album is now open. */
    m.on(switching, {
      event: switched,
      to: [ok],
      handler: (e, opts) => {
        $foldersError.set(null);
        $activeFolderId.set(e.payload.status.folder.id);
        $syncStatus.set(e.payload.status);
        opts.context.set({ pendingCreate: null, pendingActive: null, pendingName: null });
        return { state: ok };
      },
    });
    /** Opening the album failed: the previous album stays open and the person sees why. */
    m.on(switching, {
      event: switchFailed,
      to: [ok],
      handler: (e, opts) => {
        $foldersError.set(e.payload.message);
        opts.context.set({ pendingCreate: null, pendingActive: null, pendingName: null });
        return { state: ok };
      },
    });

    /** The person starts changing their name; the screen shows it is busy. */
    m.on(ok, {
      event: setName,
      to: [renaming],
      handler: (e, opts) => {
        $foldersError.set(null);
        opts.context.set({ pendingName: e.payload.name, pendingCreate: null, pendingActive: null });
        return { state: renaming };
      },
    });
    /** The new name is saved. */
    m.effect(renaming, {
      name: "renaming",
      fn: ({ signal, emit, context }) => {
        const name = context.get().pendingName;
        if (!name) {
          emit(renameFailed.create({ message: "no name given" }));
          return;
        }
        return runInvoke(
          signal,
          () => gateway.setName(name),
          (result) =>
            result
              ? emit(renamed.create({ name: (result as { name?: string } | null)?.name ?? name }))
              : emit(renameFailed.create({ message: "setName returned no data" })),
          (message) => emit(renameFailed.create({ message })),
        );
      },
    });
    /** The new name is saved and shown everywhere. */
    m.on(renaming, {
      event: renamed,
      to: [ok],
      handler: (e, opts) => {
        $foldersError.set(null);
        $userName.set(e.payload.name);
        opts.context.set({ pendingCreate: null, pendingActive: null, pendingName: null });
        return { state: ok };
      },
    });
    /** Saving the name failed: the old name stays and the person sees why. */
    m.on(renaming, {
      event: renameFailed,
      to: [ok],
      handler: (e, opts) => {
        $foldersError.set(e.payload.message);
        opts.context.set({ pendingCreate: null, pendingActive: null, pendingName: null });
        return { state: ok };
      },
    });
  },
});

const { state: stateName } = bindStateAtoms({
  actor: foldersActor,
  states: FOLDERS_STATES,
  $state: $foldersState,
  $error: $foldersError,
  $fatal: $foldersFatal,
});

export const folders = {
  state: stateName,
  refresh: () => foldersActor.send(refresh.create()),
  create: (name: string) => foldersActor.send(createFolder.create({ name })),
  switchTo: (folderId: string) => foldersActor.send(setActive.create({ folderId })),
  rename: (name: string) => foldersActor.send(setName.create({ name })),
  retry: () => foldersActor.send(retry.create()),
};
