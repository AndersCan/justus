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

const idle = state("idle")();
const refreshing = state("refreshing")();
const ok = state("ok")();
const creating = state("creating")();
const switching = state("switching")();
const renaming = state("renaming")();
const error = state("error")();

const refresh = event("REFRESH")();
const loaded = event("LOADED")<{
  name: string;
  folders: FolderSummary[];
  activeId: string | null;
}>();
const loadFailed = event("LOAD_FAILED")<{ message: string }>();
const createFolder = event("CREATE_FOLDER")<{ name: string }>();
const created = event("CREATED")<{ folder: FolderSummary }>();
const createFailed = event("CREATE_FAILED")<{ message: string }>();
const setActive = event("SET_ACTIVE")<{ folderId: string }>();
const switched = event("SWITCHED")<{ status: SyncStatus }>();
const switchFailed = event("SWITCH_FAILED")<{ message: string }>();
const setName = event("SET_NAME")<{ name: string }>();
const renamed = event("RENAMED")<{ name: string }>();
const renameFailed = event("RENAME_FAILED")<{ message: string }>();
const retry = event("RETRY")();

type FoldersContext = {
  pendingCreate: string | null;
  pendingActive: string | null;
  pendingName: string | null;
};

const foldersActor = new Actor({
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
  clock: new RealClock(),
  context: {
    pendingCreate: null,
    pendingActive: null,
    pendingName: null,
  } as FoldersContext,
  setup: (m) => {
    m.on(idle, refresh, () => {
      $foldersError.set(null);
      return { state: refreshing };
    });
    m.on(ok, refresh, () => {
      $foldersError.set(null);
      return { state: refreshing };
    });
    m.on(error, refresh, () => {
      $foldersError.set(null);
      return { state: refreshing };
    });
    m.on(error, retry, () => {
      $foldersError.set(null);
      return { state: refreshing };
    });

    m.effect(refreshing, ({ signal, emit }) => {
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
            emit(loadFailed.create({ message: "folders returned no data" }));
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
    });
    m.on(refreshing, loaded, (e) => {
      $folders.set(e.payload.folders);
      $activeFolderId.set(e.payload.activeId);
      $foldersError.set(null);
      return { state: ok };
    });
    m.on(refreshing, loadFailed, (e) => {
      $foldersError.set(e.payload.message);
      return { state: error };
    });

    m.on(ok, createFolder, (e, opts) => {
      $foldersError.set(null);
      opts.context.set({ pendingCreate: e.payload.name, pendingActive: null, pendingName: null });
      return { state: creating };
    });
    m.effect(creating, ({ signal, emit, context }) => {
      const name = context.get().pendingCreate;
      if (!name) {
        emit(createFailed.create({ message: "no folder name" }));
        return;
      }
      return runInvoke(
        signal,
        () => gateway.createFolder(name),
        (result) =>
          result
            ? emit(created.create({ folder: (result as { folder: FolderSummary }).folder }))
            : emit(createFailed.create({ message: "create returned no folder" })),
        (message) => emit(createFailed.create({ message })),
      );
    });
    m.on(creating, created, (e, opts) => {
      $foldersError.set(null);
      $folders.set([e.payload.folder, ...$folders.get()]);
      $activeFolderId.set(e.payload.folder.id);
      opts.context.set({ pendingCreate: null, pendingActive: null, pendingName: null });
      return { state: ok };
    });
    m.on(creating, createFailed, (e, opts) => {
      $foldersError.set(e.payload.message);
      opts.context.set({ pendingCreate: null, pendingActive: null, pendingName: null });
      return { state: ok };
    });

    m.on(ok, setActive, (e, opts) => {
      $foldersError.set(null);
      opts.context.set({
        pendingActive: e.payload.folderId,
        pendingCreate: null,
        pendingName: null,
      });
      return { state: switching };
    });
    m.effect(switching, ({ signal, emit, context }) => {
      const folderId = context.get().pendingActive;
      if (!folderId) {
        emit(switchFailed.create({ message: "no folder to switch to" }));
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
    });
    m.on(switching, switched, (e, opts) => {
      $foldersError.set(null);
      $activeFolderId.set(e.payload.status.folder.id);
      $syncStatus.set(e.payload.status);
      opts.context.set({ pendingCreate: null, pendingActive: null, pendingName: null });
      return { state: ok };
    });
    m.on(switching, switchFailed, (e, opts) => {
      $foldersError.set(e.payload.message);
      opts.context.set({ pendingCreate: null, pendingActive: null, pendingName: null });
      return { state: ok };
    });

    m.on(ok, setName, (e, opts) => {
      $foldersError.set(null);
      opts.context.set({ pendingName: e.payload.name, pendingCreate: null, pendingActive: null });
      return { state: renaming };
    });
    m.effect(renaming, ({ signal, emit, context }) => {
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
    });
    m.on(renaming, renamed, (e, opts) => {
      $foldersError.set(null);
      $userName.set(e.payload.name);
      opts.context.set({ pendingCreate: null, pendingActive: null, pendingName: null });
      return { state: ok };
    });
    m.on(renaming, renameFailed, (e, opts) => {
      $foldersError.set(e.payload.message);
      opts.context.set({ pendingCreate: null, pendingActive: null, pendingName: null });
      return { state: ok };
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
