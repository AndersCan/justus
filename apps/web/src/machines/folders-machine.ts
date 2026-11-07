import { Actor, RealClock, event, state, type Clock, type Snapshot } from "@mantaq/core";
import type {
  AskSummary,
  DeletedAlbum,
  FolderSummary,
  OfferSummary,
  SyncStatus,
} from "@justus/core";
import { gateway } from "../gateway";
import { fatalErrorOf, runInvoke, stateNameOf } from "./actor-utils";
import { statusSeen, syncActor, type SyncActor } from "./sync-machine";

/**
 * Folder management: the device's user name, its folder list, and the active
 * folder it is showing. Same actor pattern as the gallery/sync machines — the
 * context holds the in-flight create/rename targets the effects read.
 */

export const FOLDERS_STATES = [
  "albumsNotLoaded",
  "loadingAlbums",
  "showingAlbums",
  "creatingAlbum",
  "openingAlbum",
  "savingName",
  "archivingAlbum",
  "restoringAlbum",
  "leavingAlbum",
  "deletingAlbum",
  "dismissingDeletedNotice",
  "couldNotLoadAlbums",
  "couldNotCreateAlbum",
  "couldNotOpenAlbum",
  "couldNotSaveName",
  "couldNotChangeAlbum",
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
    archived: s.context.archived,
    deleted: s.context.deleted,
    pendingChange: s.context.pendingChange,
    asks: s.context.asks,
    offers: s.context.offers,
    activeFolderId: s.context.activeId,
    state,
    busy:
      state === "creatingAlbum" ||
      state === "openingAlbum" ||
      state === "savingName" ||
      state === "archivingAlbum" ||
      state === "restoringAlbum" ||
      state === "leavingAlbum" ||
      state === "deletingAlbum" ||
      state === "dismissingDeletedNotice",
    /** The albums are listed and nothing is in flight: fine, or the last action failed. */
    settled:
      state === "showingAlbums" ||
      state === "couldNotCreateAlbum" ||
      state === "couldNotOpenAlbum" ||
      state === "couldNotSaveName" ||
      state === "couldNotChangeAlbum",
    error: fatal?.message ?? s.context.error,
    fatal: fatal !== null,
  };
}

/** Albums have not been loaded yet. */
const albumsNotLoaded = state("albumsNotLoaded")();
/** The album list is loading. */
const loadingAlbums = state("loadingAlbums")();
/** The albums are listed and one is open. */
const showingAlbums = state("showingAlbums")();
/** A new album is being created. */
const creatingAlbum = state("creatingAlbum")();
/** The person is moving to another album. */
const openingAlbum = state("openingAlbum")();
/** The person's name is being changed. */
const savingName = state("savingName")();
/** The album is being hidden on this phone. */
const archivingAlbum = state("archivingAlbum")();
/** The album is being brought back from Archived. */
const restoringAlbum = state("restoringAlbum")();
/** The person confirmed Leave and the album is being removed from this phone. */
const leavingAlbum = state("leavingAlbum")();
/** The Admin confirmed Delete and the album is being removed for everyone. */
const deletingAlbum = state("deletingAlbum")();
/** The notice about a deleted album is being dismissed. */
const dismissingDeletedNotice = state("dismissingDeletedNotice")();
/** The albums could not be loaded; the person can try again. */
const couldNotLoadAlbums = state("couldNotLoadAlbums")();

/** The album was not created; the album list shows why. */
const couldNotCreateAlbum = state("couldNotCreateAlbum")();
/** The other album did not open; the current one stays and the person sees why. */
const couldNotOpenAlbum = state("couldNotOpenAlbum")();
/** The new name was not saved; the old name stays and the person sees why. */
const couldNotSaveName = state("couldNotSaveName")();

/** The album did not change (archive, restore, leave, delete or dismiss); it stays where it was and the context keeps what failed. */
const couldNotChangeAlbum = state("couldNotChangeAlbum")();

/** The app asks for the latest list of albums. */
const refresh = event("REFRESH")();
/** The album list arrived. */
const loaded = event("ALBUMS_LOADED")<{
  folders: FolderSummary[];
  asks: AskSummary[];
  offers: OfferSummary[];
  activeId: string | null;
  archived?: FolderSummary[];
  deleted?: DeletedAlbum[];
}>();
/** The person archives an album on this phone. */
const archiveAlbum = event("ARCHIVE_ALBUM")<AlbumTarget>();
/** The person brings an archived album back. */
const restoreAlbum = event("RESTORE_ALBUM")<AlbumTarget>();
/** The person confirmed leaving an album. */
const leaveAlbum = event("LEAVE_ALBUM")<AlbumTarget>();
/** The Admin confirmed deleting an album for everyone. */
const deleteAlbum = event("DELETE_ALBUM")<AlbumTarget>();
/** The person dismisses the notice about a deleted album. */
const dismissDeletedNotice = event("DISMISS_DELETED_NOTICE")<AlbumTarget>();
/** Archiving, restoring, leaving, deleting or dismissing did not work. */
const albumChangeFailed = event("ALBUM_CHANGE_FAILED")<{ message: string }>();
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

type AlbumTarget = { folderId: string; name: string };
type AlbumChange = "archive" | "restore" | "leave" | "delete" | "dismiss";

type FoldersContext = {
  /** The name others see; the backend holds it, so status and onboarding report it here. */
  userName: string;
  folders: FolderSummary[];
  asks: AskSummary[];
  offers: OfferSummary[];
  /** Albums archived on this phone. */
  archived: FolderSummary[];
  /** Albums the Admin deleted, until dismissed. */
  deleted: DeletedAlbum[];
  activeId: string | null;
  error: string | null;
  pendingCreate: string | null;
  pendingActive: string | null;
  pendingName: string | null;
  /** The last archive, restore, leave, delete or dismiss, kept after it ends so the screen can toast it. */
  pendingChange: (AlbumTarget & { kind: AlbumChange }) | null;
};
type FoldersPort = Pick<
  typeof gateway,
  | "folders"
  | "createFolder"
  | "setActive"
  | "setName"
  | "archiveAlbum"
  | "restoreAlbum"
  | "leaveAlbum"
  | "deleteAlbum"
  | "dismissAlbumNotice"
>;

/** The states where the album list is shown and the person can act on it. */
const settledStates = [
  showingAlbums,
  couldNotCreateAlbum,
  couldNotOpenAlbum,
  couldNotSaveName,
  couldNotChangeAlbum,
] as const;

const noPending = {
  pendingCreate: null,
  pendingActive: null,
  pendingName: null,
  pendingChange: null,
};

const changeStates = [
  ["archive", archivingAlbum, archiveAlbum],
  ["restore", restoringAlbum, restoreAlbum],
  ["leave", leavingAlbum, leaveAlbum],
  ["delete", deletingAlbum, deleteAlbum],
  ["dismiss", dismissingDeletedNotice, dismissDeletedNotice],
] as const;

/** Album calls run through `gateway` and the clock is injected, so tests and the flow inspector can drive them. */
export function createFoldersActor(options: { clock: Clock; gateway?: FoldersPort }) {
  const port = options.gateway ?? gateway;
  return Actor({
    inputs: [
      refresh,
      createFolder,
      setActive,
      setName,
      retry,
      nameSeen,
      archiveAlbum,
      restoreAlbum,
      leaveAlbum,
      deleteAlbum,
      dismissDeletedNotice,
    ],
    internal: [
      loaded,
      loadFailed,
      created,
      createFailed,
      switched,
      switchFailed,
      nameSaved,
      renameFailed,
      albumChangeFailed,
    ],
    outputs: [switchedTo, renamed],
    states: [
      albumsNotLoaded,
      loadingAlbums,
      showingAlbums,
      creatingAlbum,
      openingAlbum,
      savingName,
      archivingAlbum,
      restoringAlbum,
      leavingAlbum,
      deletingAlbum,
      dismissingDeletedNotice,
      couldNotLoadAlbums,
      couldNotCreateAlbum,
      couldNotOpenAlbum,
      couldNotSaveName,
      couldNotChangeAlbum,
    ],
    initial: albumsNotLoaded,
    clock: options.clock,
    context: {
      userName: "",
      folders: [],
      asks: [],
      offers: [],
      archived: [],
      deleted: [],
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
      m.on(albumsNotLoaded, {
        event: refresh,
        to: [loadingAlbums],
        handler: (_e, opts) => {
          opts.context.set({ ...opts.context.get(), error: null });
          return { state: loadingAlbums };
        },
      });
      for (const at of settledStates) {
        /** Refreshing the albums starts a reload and clears any error. */
        m.on(at, {
          event: refresh,
          to: [loadingAlbums],
          handler: (_e, opts) => {
            opts.context.set({ ...opts.context.get(), error: null });
            return { state: loadingAlbums };
          },
        });
      }
      /** After an error, refreshing starts a reload and clears the error. */
      m.on(couldNotLoadAlbums, {
        event: refresh,
        to: [loadingAlbums],
        handler: (_e, opts) => {
          opts.context.set({ ...opts.context.get(), error: null });
          return { state: loadingAlbums };
        },
      });
      /** Try again after an error reloads the albums. */
      m.on(couldNotLoadAlbums, {
        event: retry,
        to: [loadingAlbums],
        handler: (_e, opts) => {
          opts.context.set({ ...opts.context.get(), error: null });
          return { state: loadingAlbums };
        },
      });

      /** The albums are fetched from the app's storage. */
      m.effect(loadingAlbums, {
        name: "loadingAlbums",
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
                offers?: OfferSummary[];
                archived?: FolderSummary[];
                deleted?: DeletedAlbum[];
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
                  offers: r.offers ?? [],
                  activeId: r.activeFolderId ?? null,
                  archived: r.archived ?? [],
                  deleted: r.deleted ?? [],
                }),
              );
            },
            (message) => emit(loadFailed.create({ message })),
          );
        },
      });
      /** The albums are listed and the active album is marked; an empty first-run device with no album chosen is fine. */
      m.on(loadingAlbums, {
        event: loaded,
        to: [showingAlbums],
        handler: (e, opts) => {
          opts.context.set({
            ...opts.context.get(),
            folders: e.payload.folders,
            asks: e.payload.asks,
            offers: e.payload.offers,
            archived: e.payload.archived ?? [],
            deleted: e.payload.deleted ?? [],
            activeId: e.payload.activeId,
            error: null,
          });
          return { state: showingAlbums };
        },
      });
      /** Loading failed: an error is shown with a way to try again. */
      m.on(loadingAlbums, {
        event: loadFailed,
        to: [couldNotLoadAlbums],
        handler: (e, opts) => {
          opts.context.set({ ...opts.context.get(), error: e.payload.message });
          return { state: couldNotLoadAlbums };
        },
      });

      for (const at of settledStates) {
        /** The person starts creating an album; the screen shows it is busy. */
        m.on(at, {
          event: createFolder,
          to: [creatingAlbum],
          handler: (e, opts) => {
            opts.context.set({
              ...opts.context.get(),
              ...noPending,
              error: null,
              pendingCreate: e.payload.name,
            });
            return { state: creatingAlbum };
          },
        });
      }
      /** The new album is created. */
      m.effect(creatingAlbum, {
        name: "creatingAlbum",
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
      m.on(creatingAlbum, {
        event: created,
        to: [showingAlbums],
        handler: (e, opts) => {
          const context = opts.context.get();
          opts.context.set({
            ...context,
            ...noPending,
            folders: [e.payload.folder, ...context.folders],
            activeId: e.payload.folder.id,
            error: null,
          });
          return { state: showingAlbums };
        },
      });
      /** Creating failed: the list is unchanged and the person sees why. */
      m.on(creatingAlbum, {
        event: createFailed,
        to: [couldNotCreateAlbum],
        handler: (e, opts) => {
          opts.context.set({ ...opts.context.get(), ...noPending, error: e.payload.message });
          return { state: couldNotCreateAlbum };
        },
      });

      for (const at of settledStates) {
        /** The person picks another album; the screen shows it is busy. */
        m.on(at, {
          event: setActive,
          to: [openingAlbum],
          handler: (e, opts) => {
            opts.context.set({
              ...opts.context.get(),
              ...noPending,
              error: null,
              pendingActive: e.payload.folderId,
            });
            return { state: openingAlbum };
          },
        });
      }
      /** The chosen album is opened. */
      m.effect(openingAlbum, {
        name: "openingAlbum",
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
      m.on(openingAlbum, {
        event: switched,
        to: [showingAlbums],
        handler: (e, opts) => {
          opts.context.set({
            ...opts.context.get(),
            ...noPending,
            activeId: e.payload.status.folder.id,
            error: null,
          });
          return { state: showingAlbums, emit: [switchedTo.create({ status: e.payload.status })] };
        },
      });
      /** Opening the album failed: the previous album stays open and the person sees why. */
      m.on(openingAlbum, {
        event: switchFailed,
        to: [couldNotOpenAlbum],
        handler: (e, opts) => {
          opts.context.set({ ...opts.context.get(), ...noPending, error: e.payload.message });
          return { state: couldNotOpenAlbum };
        },
      });

      for (const at of settledStates) {
        /** The person starts changing their name; the screen shows it is busy. */
        m.on(at, {
          event: setName,
          to: [savingName],
          handler: (e, opts) => {
            opts.context.set({
              ...opts.context.get(),
              ...noPending,
              error: null,
              pendingName: e.payload.name,
            });
            return { state: savingName };
          },
        });
      }
      /** The new name is saved. */
      m.effect(savingName, {
        name: "savingName",
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
      m.on(savingName, {
        event: nameSaved,
        to: [showingAlbums],
        handler: (e, opts) => {
          opts.context.set({
            ...opts.context.get(),
            ...noPending,
            userName: e.payload.name,
            error: null,
          });
          return { state: showingAlbums, emit: [renamed.create({ name: e.payload.name })] };
        },
      });
      /** Saving the name failed: the old name stays and the person sees why. */
      m.on(savingName, {
        event: renameFailed,
        to: [couldNotSaveName],
        handler: (e, opts) => {
          opts.context.set({ ...opts.context.get(), ...noPending, error: e.payload.message });
          return { state: couldNotSaveName };
        },
      });

      for (const [kind, inFlight, trigger] of changeStates) {
        for (const at of settledStates) {
          /** The person archives, restores, leaves, deletes or dismisses; the screen shows it is busy. */
          m.on(at, {
            event: trigger,
            to: [inFlight],
            handler: (e, opts) => {
              opts.context.set({
                ...opts.context.get(),
                ...noPending,
                error: null,
                pendingChange: { kind, ...e.payload },
              });
              return { state: inFlight };
            },
          });
        }
        /** The change is made, then the lists are loaded again so every list is current. */
        m.effect(inFlight, {
          name: inFlight.name,
          sends: [loaded, albumChangeFailed],
          fn: ({ signal, emit, context }) => {
            const pending = context.get().pendingChange;
            if (!pending) {
              emit(albumChangeFailed.create({ message: "no album to change" }));
              return;
            }
            const calls = {
              archive: port.archiveAlbum,
              restore: port.restoreAlbum,
              leave: port.leaveAlbum,
              delete: port.deleteAlbum,
              dismiss: port.dismissAlbumNotice,
            };
            const fail = (message: string) => emit(albumChangeFailed.create({ message }));
            return runInvoke(
              signal,
              () => calls[pending.kind](pending.folderId),
              () =>
                void runInvoke(
                  signal,
                  () => port.folders(),
                  (result) => {
                    const r = result as {
                      folders?: FolderSummary[];
                      activeFolderId?: string;
                      asks?: AskSummary[];
                      offers?: OfferSummary[];
                      archived?: FolderSummary[];
                      deleted?: DeletedAlbum[];
                    } | null;
                    if (!r?.folders) return fail("albums returned no data");
                    emit(
                      loaded.create({
                        folders: r.folders,
                        asks: r.asks ?? [],
                        offers: r.offers ?? [],
                        activeId: r.activeFolderId ?? null,
                        archived: r.archived ?? [],
                        deleted: r.deleted ?? [],
                      }),
                    );
                  },
                  fail,
                ),
              fail,
            );
          },
        });
        /** The change is done and the lists are current. */
        m.on(inFlight, {
          event: loaded,
          to: [showingAlbums],
          handler: (e, opts) => {
            opts.context.set({
              ...opts.context.get(),
              folders: e.payload.folders,
              asks: e.payload.asks,
              offers: e.payload.offers,
              archived: e.payload.archived ?? [],
              deleted: e.payload.deleted ?? [],
              activeId: e.payload.activeId,
              error: null,
            });
            return { state: showingAlbums };
          },
        });
        /** The change failed: the album stays where it was and the context keeps what failed. */
        m.on(inFlight, {
          event: albumChangeFailed,
          to: [couldNotChangeAlbum],
          handler: (e, opts) => {
            opts.context.set({ ...opts.context.get(), error: e.payload.message });
            return { state: couldNotChangeAlbum };
          },
        });
      }
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
  archive: (folderId: string, name: string) =>
    foldersActor.send(archiveAlbum.create({ folderId, name })),
  restore: (folderId: string, name: string) =>
    foldersActor.send(restoreAlbum.create({ folderId, name })),
  leave: (folderId: string, name: string) =>
    foldersActor.send(leaveAlbum.create({ folderId, name })),
  delete: (folderId: string, name: string) =>
    foldersActor.send(deleteAlbum.create({ folderId, name })),
  dismissNotice: (folderId: string, name: string) =>
    foldersActor.send(dismissDeletedNotice.create({ folderId, name })),
};
