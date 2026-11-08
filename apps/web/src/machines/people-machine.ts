import { Actor, RealClock, event, state, type Clock, type Snapshot } from "@mantaq/core";
import { onOutput } from "@mantaq/sugar";
import { gateway } from "../gateway";
import { buildPeople } from "../utils/people";
import { fatalErrorOf, runInvoke, stateNameOf } from "./actor-utils";
import { requests } from "./requests-machine";
import type { JoinRequest, SyncStatus } from "@justus/core";

/**
 * The People sheet: opened from the header chip, closed again, and the
 * Admin's Remove action. The members themselves come from the sync status;
 * pending requests from the requests machine.
 */

const PEOPLE_STATES = [
  "peopleSheetClosed",
  "showingPeople",
  "removingMember",
  "couldNotRemoveMember",
  "lettingViewerAddPhotos",
  "couldNotLetViewerAddPhotos",
  "makingViewer",
  "couldNotMakeViewer",
] as const;
export type PeopleStateName = (typeof PEOPLE_STATES)[number];

/** The People sheet is hidden. */
const peopleSheetClosed = state("peopleSheetClosed")();
/** The People sheet is showing the album's members and anyone waiting to join. */
const showingPeople = state("showingPeople")();
/** The Admin has asked to remove someone and the sheet waits for that to finish. */
const removingMember = state("removingMember")();
/** Removing the member failed; the sheet stays open, says why, and the member stays in the album. */
const couldNotRemoveMember = state("couldNotRemoveMember")();
/** Saving that the Viewer can add photos; the sheet's buttons wait. */
const lettingViewerAddPhotos = state("lettingViewerAddPhotos")();
/** It could not be saved; the person stays a Viewer and the sheet says why. */
const couldNotLetViewerAddPhotos = state("couldNotLetViewerAddPhotos")();
/** Saving that the Collaborator is a Viewer now; the sheet's buttons wait. */
const makingViewer = state("makingViewer")();
/** It could not be saved; the person stays a Collaborator and the sheet says why. */
const couldNotMakeViewer = state("couldNotMakeViewer")();

/** The person taps the people chip to see who is in the album. */
const openSheet = event("OPEN")();
/** The person closes the People sheet. */
const closeSheet = event("CLOSE")();
/** The Admin chooses to remove a member from the album. */
const removeMember = event("REMOVE_MEMBER")<{ folderId: string; memberKey: string }>();
/** The member was taken out of the album. */
const removed = event("REMOVED")();
/** The member could not be removed. */
const removeFailed = event("REMOVE_FAILED")<{ message: string }>();
/** The Admin lets a Viewer add photos. */
const letViewerAddPhotos = event("LET_VIEWER_ADD_PHOTOS")<{
  folderId: string;
  memberKey: string;
}>();
/** The Viewer can add photos now. */
const viewerCanAddPhotos = event("VIEWER_CAN_ADD_PHOTOS")();
/** The Viewer could not be let add photos. */
const letViewerAddFailed = event("LET_VIEWER_ADD_FAILED")<{ message: string }>();

/** The Admin makes a Collaborator a Viewer. */
const makeViewer = event("MAKE_VIEWER")<{ folderId: string; memberKey: string }>();
/** The Collaborator is a Viewer now. */
const madeViewer = event("MADE_VIEWER")();
/** The Collaborator could not be made a Viewer. */
const makeViewerFailed = event("MAKE_VIEWER_FAILED")<{ message: string }>();

/** The person asks to see the invite QR code. */
const showQr = event("SHOW_QR")();

/** The sheet was just opened, so the latest join requests are worth fetching. */
const sheetOpened = event("SHEET_OPENED")();

/** The Viewer can add photos now; the view tells the Admin. */
const viewerLetAddPhotos = event("VIEWER_LET_ADD_PHOTOS")<{ memberKey: string }>();

/** The Collaborator is a Viewer now; the view tells the Admin. */
const memberMadeViewer = event("MEMBER_MADE_VIEWER")<{ memberKey: string }>();

/** The member is out of the album; the view tells the Admin. */
const memberRemoved = event("MEMBER_REMOVED")<{ memberKey: string }>();

type PeopleContext = {
  pending: { folderId: string; memberKey: string } | null;
  error: string | null;
  qrShown: boolean;
};
const nameOf = stateNameOf(PEOPLE_STATES);

/** Someone who can already add photos counts as done. */
function isAlreadyEnrolled(err: unknown) {
  const e = err as { code?: string; message?: string } | null;
  return e?.code === "justus.photos/already-enrolled" || /already enrolled/i.test(e?.message ?? "");
}

/** The People sheet view model as a pure function of the actor snapshot and
 * the values other machines own: the sync status, the join requests and the
 * saved friend names. */
export function peopleViewModel(
  s: Snapshot<PeopleContext>,
  deps: { status: SyncStatus | null; requests: JoinRequest[]; friends: Record<string, string> },
) {
  const state = nameOf(s);
  return {
    ...buildPeople(deps.status, deps.requests, deps.friends),
    open: state !== "peopleSheetClosed",
    busy:
      state === "removingMember" || state === "lettingViewerAddPhotos" || state === "makingViewer",
    qrShown: s.context.qrShown,
    error: fatalErrorOf(s)?.message ?? s.context.error,
    isAdmin: deps.status?.folder.role === "creator",
    folder: deps.status?.folder ?? null,
    myName: deps.status?.name ?? "",
  };
}

type PeoplePort = Pick<typeof gateway, "removeMember" | "makeMember" | "makeViewer">;

/** The Admin's removal runs through `gateway` and the clock is injected, so tests and the flow inspector can drive it. */
export function createPeopleActor(options: { clock: Clock; gateway?: PeoplePort }) {
  const port = options.gateway ?? gateway;
  return Actor({
    inputs: [openSheet, closeSheet, removeMember, letViewerAddPhotos, makeViewer, showQr],
    internal: [
      removed,
      removeFailed,
      viewerCanAddPhotos,
      letViewerAddFailed,
      madeViewer,
      makeViewerFailed,
    ],
    outputs: [sheetOpened, viewerLetAddPhotos, memberMadeViewer, memberRemoved],
    states: [
      peopleSheetClosed,
      showingPeople,
      removingMember,
      couldNotRemoveMember,
      lettingViewerAddPhotos,
      couldNotLetViewerAddPhotos,
      makingViewer,
      couldNotMakeViewer,
    ],
    initial: peopleSheetClosed,
    clock: options.clock,
    context: { pending: null, error: null, qrShown: false } as PeopleContext,
    setup: (m) => {
      /** Opening the sheet clears any old error and asks for the latest join requests. */
      m.on(peopleSheetClosed, {
        event: openSheet,
        to: [showingPeople],
        handler: (_e, opts) => {
          opts.context.set({ pending: null, error: null, qrShown: false });
          return { state: showingPeople, emit: [sheetOpened.create()] };
        },
      });
      for (const at of [
        showingPeople,
        couldNotRemoveMember,
        couldNotLetViewerAddPhotos,
        couldNotMakeViewer,
      ]) {
        /** Closing the sheet hides it again. */
        m.on(at, {
          event: closeSheet,
          to: [peopleSheetClosed],
          handler: (_e, opts) => {
            opts.context.set({ ...opts.context.get(), qrShown: false });
            return { state: peopleSheetClosed };
          },
        });
        /** The person asks for the invite QR code; it stays up until the sheet closes. */
        m.on(at, {
          event: showQr,
          handler: (_e, opts) => {
            opts.context.set({ ...opts.context.get(), qrShown: true });
            return {};
          },
        });
        /** The Admin picks a member to remove; the sheet shows that it is working. */
        m.on(at, {
          event: removeMember,
          to: [removingMember],
          handler: (e, opts) => {
            opts.context.set({ ...opts.context.get(), pending: e.payload, error: null });
            return { state: removingMember };
          },
        });
        /** The Admin lets a Viewer add photos; the sheet shows that it is working. */
        m.on(at, {
          event: letViewerAddPhotos,
          to: [lettingViewerAddPhotos],
          handler: (e, opts) => {
            opts.context.set({ ...opts.context.get(), pending: e.payload, error: null });
            return { state: lettingViewerAddPhotos };
          },
        });
        /** The Admin makes a Collaborator a Viewer; the sheet shows that it is working. */
        m.on(at, {
          event: makeViewer,
          to: [makingViewer],
          handler: (e, opts) => {
            opts.context.set({ ...opts.context.get(), pending: e.payload, error: null });
            return { state: makingViewer };
          },
        });
      }
      /** The person asks for the invite QR code while a member is being removed; it stays up until the sheet closes. */
      m.on(removingMember, {
        event: showQr,
        handler: (_e, opts) => {
          opts.context.set({ ...opts.context.get(), qrShown: true });
          return {};
        },
      });
      /** The person asks for the invite QR code while a Viewer is being let add photos; it stays up until the sheet closes. */
      m.on(lettingViewerAddPhotos, {
        event: showQr,
        handler: (_e, opts) => {
          opts.context.set({ ...opts.context.get(), qrShown: true });
          return {};
        },
      });
      /** The person asks for the invite QR code while a Collaborator is being made a Viewer; it stays up until the sheet closes. */
      m.on(makingViewer, {
        event: showQr,
        handler: (_e, opts) => {
          opts.context.set({ ...opts.context.get(), qrShown: true });
          return {};
        },
      });
      /** The Collaborator is made a Viewer. */
      m.effect(makingViewer, {
        name: "makingViewer",
        sends: [madeViewer, makeViewerFailed],
        fn: ({ signal, emit, context }) => {
          const pending = context.get().pending;
          if (!pending) {
            emit(makeViewerFailed.create({ message: "no member to update" }));
            return;
          }
          return runInvoke(
            signal,
            () => port.makeViewer(pending.folderId, pending.memberKey),
            () => emit(madeViewer.create()),
            (message) => emit(makeViewerFailed.create({ message })),
          );
        },
      });
      /** The Collaborator is a Viewer and the sheet shows the updated row. */
      m.on(makingViewer, {
        event: madeViewer,
        to: [showingPeople],
        handler: (_e, opts) => {
          const memberKey = opts.context.get().pending?.memberKey ?? "";
          opts.context.set({ ...opts.context.get(), pending: null, error: null });
          return { state: showingPeople, emit: [memberMadeViewer.create({ memberKey })] };
        },
      });
      /** Saving failed: the sheet stays open and says why, and the person stays a Collaborator. */
      m.on(makingViewer, {
        event: makeViewerFailed,
        to: [couldNotMakeViewer],
        handler: (e, opts) => {
          opts.context.set({ ...opts.context.get(), pending: null, error: e.payload.message });
          return { state: couldNotMakeViewer };
        },
      });
      /** The Viewer is made a Collaborator. */
      m.effect(lettingViewerAddPhotos, {
        name: "lettingViewerAddPhotos",
        sends: [viewerCanAddPhotos, letViewerAddFailed],
        fn: ({ signal, emit, context }) => {
          const pending = context.get().pending;
          if (!pending) {
            emit(letViewerAddFailed.create({ message: "no member to update" }));
            return;
          }
          return (async () => {
            try {
              const [err] = await port.makeMember(pending.folderId, pending.memberKey);
              if (signal.aborted) return;
              if (!err || isAlreadyEnrolled(err)) emit(viewerCanAddPhotos.create());
              else emit(letViewerAddFailed.create({ message: err.message || "unknown error" }));
            } catch (e) {
              if (signal.aborted) return;
              emit(
                letViewerAddFailed.create({ message: e instanceof Error ? e.message : String(e) }),
              );
            }
          })();
        },
      });
      /** The Viewer can add photos and the sheet shows the updated list. */
      m.on(lettingViewerAddPhotos, {
        event: viewerCanAddPhotos,
        to: [showingPeople],
        handler: (_e, opts) => {
          const memberKey = opts.context.get().pending?.memberKey ?? "";
          opts.context.set({ ...opts.context.get(), pending: null, error: null });
          return { state: showingPeople, emit: [viewerLetAddPhotos.create({ memberKey })] };
        },
      });
      /** Saving failed: the sheet stays open and says why, and the person stays a Viewer. */
      m.on(lettingViewerAddPhotos, {
        event: letViewerAddFailed,
        to: [couldNotLetViewerAddPhotos],
        handler: (e, opts) => {
          opts.context.set({ ...opts.context.get(), pending: null, error: e.payload.message });
          return { state: couldNotLetViewerAddPhotos };
        },
      });
      /** The member is taken out of the album. */
      m.effect(removingMember, {
        name: "removingMember",
        sends: [removed, removeFailed],
        fn: ({ signal, emit, context }) => {
          const pending = context.get().pending;
          if (!pending) {
            emit(removeFailed.create({ message: "no member to remove" }));
            return;
          }
          return runInvoke(
            signal,
            () => port.removeMember(pending.folderId, pending.memberKey),
            () => emit(removed.create()),
            (message) => emit(removeFailed.create({ message })),
          );
        },
      });
      /** The member is gone and the sheet shows the updated list. */
      m.on(removingMember, {
        event: removed,
        to: [showingPeople],
        handler: (_e, opts) => {
          const pending = opts.context.get().pending;
          opts.context.set({ ...opts.context.get(), pending: null, error: null });
          if (!pending) return { state: showingPeople };
          return {
            state: showingPeople,
            emit: [memberRemoved.create({ memberKey: pending.memberKey })],
          };
        },
      });
      /** Removing failed: the sheet stays open and tells the person what went wrong, and the member stays in the album. */
      m.on(removingMember, {
        event: removeFailed,
        to: [couldNotRemoveMember],
        handler: (e, opts) => {
          opts.context.set({ ...opts.context.get(), pending: null, error: e.payload.message });
          return { state: couldNotRemoveMember };
        },
      });
    },
  });
}

export const peopleActor = createPeopleActor({ clock: RealClock() });

onOutput(peopleActor, (e) => {
  if (e.type === "sheetOpened" || e.type === "SHEET_OPENED") requests.refresh();
});

export const people = {
  makeViewer: (folderId: string, memberKey: string) =>
    peopleActor.send(makeViewer.create({ folderId, memberKey })),
  open: () => peopleActor.send(openSheet.create()),
  close: () => peopleActor.send(closeSheet.create()),
  showQr: () => peopleActor.send(showQr.create()),
  remove: (folderId: string, memberKey: string) =>
    peopleActor.send(removeMember.create({ folderId, memberKey })),
  letViewerAddPhotos: (folderId: string, memberKey: string) =>
    peopleActor.send(letViewerAddPhotos.create({ folderId, memberKey })),
};
