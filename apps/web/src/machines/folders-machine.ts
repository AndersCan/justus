import { Actor, RealClock, event, state, type Clock, type Snapshot } from "@mantaq/core";
import type { AskSummary, FolderSummary, SyncStatus } from "@justus/core";
import { gateway } from "../gateway";
import { fatalErrorOf, runInvoke, stateNameOf } from "./actor-utils";
import { statusSeen, syncActor, type SyncActor } from "./sync-machine";

/**
 * Folder management: the device's user name, its folder list, and the active
 * folder it is showing. Same actor pattern as the gallery/sync machines — the
 * context holds the in-flight create/rename targets the effects read.
 */

export const FOLDERS_STATES = [
  "idle",
  "refreshing",
  "ok",
  "creating",
  "switching",
  "renaming",
  "error",
] as const;
export type FoldersStateName = (typeof FOLDERS_STATES)[number];

const nameOf = stateNameOf(FOLDERS_STATES);

/** The folders UI's view model as a pure function of the actor snapshot; a
 * fatal message replaces the context error. */
export function foldersViewModel(s: Snapshot<FoldersContext>) {
  const state = nameOf(s);
  const fatal = fatalErrorOf(s);
  return {
    userName: s.context.userName,
    folders: s.context.folders,
    asks: s.context.asks,
    activeFolderId: s.context.activeId,
    state,
    busy: state === "creating" || state === "switching" || state === "renaming",
    error: fatal?.message ?? s.context.error,
    fatal: fatal !== null,
  };
}

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
  folders: FolderSummary[];
  asks: AskSummary[];
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
const nameSaved = event("NAME_SAVED")<{ name: string }>();
/** The new name could not be saved. */
const renameFailed = event("RENAME_FAILED")<{ message: string }>();
/** The person taps Try again after an error. */
const retry = event("RETRY")();
/** Another part of the app reports the name the backend holds for this device. */
export const nameSeen = event("NAME_SEEN")<{ name: string }>();

/** The other album is open and the app's sync status should follow it. */
const switchedTo = event("SWITCHED_TO")<{ status: SyncStatus }>();
/** The new name was saved and should be shown everywhere. */
const renamed = event("RENAMED")<{ name: string }>();

type FoldersContext = {
  /** The name others see; the backend holds it, so status and onboarding report it here. */
  userName: string;
  folders: FolderSummary[];
  asks: AskSummary[];
  activeId: string | null;
  error: string | null;
  pendingCreate: string | null;
  pendingActive: string | null;
  pendingName: string | null;
};
type FoldersPort = Pick<typeof gateway, "folders" | "createFolder" | "setActive" | "setName">;

const noPending = { pendingCreate: null, pendingActive: null, pendingName: null };

/** Album calls run through `gateway` and the clock is injected, so tests and the flow inspector can drive them. */
export function createFoldersActor(options: { clock: Clock; gateway?: FoldersPort }) {
  const port = options.gateway ?? gateway;
  return Actor({
    inputs: [refresh, createFolder, setActive, setName, retry, nameSeen],
    internal: [
      loaded,
      loadFailed,
      created,
      createFailed,
      switched,
      switchFailed,
      nameSaved,
      renameFailed,
    ],
    outputs: [switchedTo, renamed],
    states: [idle, refreshing, ok, creating, switching, renaming, error],
    initial: idle,
    clock: options.clock,
    context: {
      userName: "",
      folders: [],
      asks: [],
      activeId: null,
      error: null,
      ...noPending,
    } as FoldersContext,
    setup: (m) => {
      /** The backend reports this device's name: it becomes the name shown, in any state. */
      m.onAny({
        event: nameSeen,
        handler: (e, opts) => {
          opts.context.set({ ...opts.context.get(), userName: e.payload.name });
          return {};
        },
      });
      /** First load of albums starts and any error is cleared. */
      m.on(idle, {
        event: refresh,
        to: [refreshing],
        handler: (_e, opts) => {
          opts.context.set({ ...opts.context.get(), error: null });
          return { state: refreshing };
        },
      });
      /** Refreshing the albums starts a reload and clears any error. */
      m.on(ok, {
        event: refresh,
        to: [refreshing],
        handler: (_e, opts) => {
          opts.context.set({ ...opts.context.get(), error: null });
          return { state: refreshing };
        },
      });
      /** After an error, refreshing starts a reload and clears the error. */
      m.on(error, {
        event: refresh,
        to: [refreshing],
        handler: (_e, opts) => {
          opts.context.set({ ...opts.context.get(), error: null });
          return { state: refreshing };
        },
      });
      /** Try again after an error reloads the albums. */
      m.on(error, {
        event: retry,
        to: [refreshing],
        handler: (_e, opts) => {
          opts.context.set({ ...opts.context.get(), error: null });
          return { state: refreshing };
        },
      });

      /** The albums are fetched from the app's storage. */
      m.effect(refreshing, {
        name: "refreshing",
        sends: [loaded, loadFailed],
        fn: ({ signal, emit }) => {
          return runInvoke(
            signal,
            () => port.folders(),
            (result) => {
              const r = result as {
                folders?: FolderSummary[];
                activeFolderId?: string;
                asks?: AskSummary[];
              } | null;
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
                  folders: r.folders,
                  asks: r.asks ?? [],
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
        handler: (e, opts) => {
          opts.context.set({
            ...opts.context.get(),
            folders: e.payload.folders,
            asks: e.payload.asks,
            activeId: e.payload.activeId,
            error: null,
          });
          return { state: ok };
        },
      });
      /** Loading failed: an error is shown with a way to try again. */
      m.on(refreshing, {
        event: loadFailed,
        to: [error],
        handler: (e, opts) => {
          opts.context.set({ ...opts.context.get(), error: e.payload.message });
          return { state: error };
        },
      });

      /** The person starts creating an album; the screen shows it is busy. */
      m.on(ok, {
        event: createFolder,
        to: [creating],
        handler: (e, opts) => {
          opts.context.set({
            ...opts.context.get(),
            ...noPending,
            error: null,
            pendingCreate: e.payload.name,
          });
          return { state: creating };
        },
      });
      /** The new album is created. */
      m.effect(creating, {
        name: "creating",
        sends: [created, createFailed],
        fn: ({ signal, emit, context }) => {
          const name = context.get().pendingCreate;
          if (!name) {
            emit(createFailed.create({ message: "no album name" }));
            return;
          }
          return runInvoke(
            signal,
            () => port.createFolder(name),
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
          const context = opts.context.get();
          opts.context.set({
            ...context,
            ...noPending,
            folders: [e.payload.folder, ...context.folders],
            activeId: e.payload.folder.id,
            error: null,
          });
          return { state: ok };
        },
      });
      /** Creating failed: the list is unchanged and the person sees why. */
      m.on(creating, {
        event: createFailed,
        to: [ok],
        handler: (e, opts) => {
          opts.context.set({ ...opts.context.get(), ...noPending, error: e.payload.message });
          return { state: ok };
        },
      });

      /** The person picks another album; the screen shows it is busy. */
      m.on(ok, {
        event: setActive,
        to: [switching],
        handler: (e, opts) => {
          opts.context.set({
            ...opts.context.get(),
            ...noPending,
            error: null,
            pendingActive: e.payload.folderId,
          });
          return { state: switching };
        },
      });
      /** The chosen album is opened. */
      m.effect(switching, {
        name: "switching",
        sends: [switched, switchFailed],
        fn: ({ signal, emit, context }) => {
          const folderId = context.get().pendingActive;
          if (!folderId) {
            emit(switchFailed.create({ message: "no album to switch to" }));
            return;
          }
          return runInvoke(
            signal,
            () => port.setActive(folderId),
            (result) =>
              result
                ? emit(switched.create({ status: result as SyncStatus }))
                : emit(switchFailed.create({ message: "switch returned no status" })),
            (message) => emit(switchFailed.create({ message })),
          );
        },
      });
      /** The picked album is now open and the sync status follows it. */
      m.on(switching, {
        event: switched,
        to: [ok],
        handler: (e, opts) => {
          opts.context.set({
            ...opts.context.get(),
            ...noPending,
            activeId: e.payload.status.folder.id,
            error: null,
          });
          return { state: ok, emit: [switchedTo.create({ status: e.payload.status })] };
        },
      });
      /** Opening the album failed: the previous album stays open and the person sees why. */
      m.on(switching, {
        event: switchFailed,
        to: [ok],
        handler: (e, opts) => {
          opts.context.set({ ...opts.context.get(), ...noPending, error: e.payload.message });
          return { state: ok };
        },
      });

      /** The person starts changing their name; the screen shows it is busy. */
      m.on(ok, {
        event: setName,
        to: [renaming],
        handler: (e, opts) => {
          opts.context.set({
            ...opts.context.get(),
            ...noPending,
            error: null,
            pendingName: e.payload.name,
          });
          return { state: renaming };
        },
      });
      /** The new name is saved. */
      m.effect(renaming, {
        name: "renaming",
        sends: [nameSaved, renameFailed],
        fn: ({ signal, emit, context }) => {
          const name = context.get().pendingName;
          if (!name) {
            emit(renameFailed.create({ message: "no name given" }));
            return;
          }
          return runInvoke(
            signal,
            () => port.setName(name),
            (result) =>
              result
                ? emit(
                    nameSaved.create({ name: (result as { name?: string } | null)?.name ?? name }),
                  )
                : emit(renameFailed.create({ message: "setName returned no data" })),
            (message) => emit(renameFailed.create({ message })),
          );
        },
      });
      /** The new name is saved and shown everywhere. */
      m.on(renaming, {
        event: nameSaved,
        to: [ok],
        handler: (e, opts) => {
          opts.context.set({
            ...opts.context.get(),
            ...noPending,
            userName: e.payload.name,
            error: null,
          });
          return { state: ok, emit: [renamed.create({ name: e.payload.name })] };
        },
      });
      /** Saving the name failed: the old name stays and the person sees why. */
      m.on(renaming, {
        event: renameFailed,
        to: [ok],
        handler: (e, opts) => {
          opts.context.set({ ...opts.context.get(), ...noPending, error: e.payload.message });
          return { state: ok };
        },
      });
    },
  });
}

export const foldersActor = createFoldersActor({ clock: RealClock() });

export type FoldersActor = ReturnType<typeof createFoldersActor>;

/** Folders and sync each own one value and tell the other when theirs moves:
 * a switched album gives sync its new status, and a status with a new name
 * gives folders that name. The name check keeps the two from echoing. */
export function wireFoldersToSync(folders: FoldersActor, sync: SyncActor): () => void {
  const offOutput = folders.on("output", {
    fn: (e) => {
      if (e.type === switchedTo.type) {
        sync.send(statusSeen.create({ status: (e.payload as { status: SyncStatus }).status }));
      }
    },
  });
  const offChange = sync.on("change", {
    fn: (snapshot) => {
      const name = snapshot.context.status?.name;
      if (name && name !== folders.snapshot().context.userName) {
        folders.send(nameSeen.create({ name }));
      }
    },
  });
  return () => {
    offOutput();
    offChange();
  };
}

wireFoldersToSync(foldersActor, syncActor);

export const folders = {
  state: () => nameOf(foldersActor.snapshot()),
  refresh: () => foldersActor.send(refresh.create()),
  create: (name: string) => foldersActor.send(createFolder.create({ name })),
  switchTo: (folderId: string) => foldersActor.send(setActive.create({ folderId })),
  rename: (name: string) => foldersActor.send(setName.create({ name })),
  retry: () => foldersActor.send(retry.create()),
};
