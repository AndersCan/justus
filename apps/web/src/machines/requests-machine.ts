import { Actor, RealClock, event, state, type Clock, type Snapshot } from "@mantaq/core";
import type { JoinRequest } from "@justus/core";
import { gateway } from "../gateway";
import { fatalErrorOf, runInvoke, stateNameOf } from "./actor-utils";
import { removeRequestFromList } from "./requests-list";

import { copy } from "../copy/copy";
/**
 * Join-request inbox: pending "<name> wants to join <album>" requests shown
 * to this device's Admins, each with Yes/No. Same actor pattern as
 * the other machines.
 */

/** Accept all in progress: `next` is being sent now, `after` waits its turn, `sent` are already in. */
type Batch = { folderId: string; next: string; after: string[]; sent: number };

/** The people the Accept all sheet names. */
export type AcceptAllSheet = { folderId: string; requesterKeys: string[] };

const REQUESTS_STATES = [
  "requestsNotLoaded",
  "loadingRequests",
  "showingRequests",
  "confirmingAcceptAll",
  "sendingAnswer",
  "sendingAnswersToAll",
  "couldNotLoadRequests",
  "couldNotSendAnswer",
] as const;

/** The inbox of requests to join the person's albums has not been loaded yet. */
const requestsNotLoaded = state("requestsNotLoaded")();
/** Loading the requests from people who want to join. */
const loadingRequests = state("loadingRequests")();
/** The requests are shown, each with Yes and No. */
const showingRequests = state("showingRequests")();
/** The Admin tapped Accept all: a sheet names everyone it would let in, with their check codes; nobody is answered until Accept. */
const confirmingAcceptAll = state("confirmingAcceptAll")<AcceptAllSheet>();
/** Sending the person's Yes or No; buttons are disabled meanwhile. */
const sendingAnswer = state("sendingAnswer")();
/** Accept all as Viewers is sending the answers one by one; every button is off and each card leaves as its answer is sent. */
const sendingAnswersToAll = state("sendingAnswersToAll")<Batch>();
/** The Yes or No did not go through; the request stays and its card shows why, with Retry. */
const couldNotSendAnswer = state("couldNotSendAnswer")();
/** The requests could not be loaded; the person sees the problem and can try again. */
const couldNotLoadRequests = state("couldNotLoadRequests")();

/** The person opens the requests inbox or asks it to reload. */
const refresh = event("REFRESH")();
/** The list of requests came back. */
const loaded = event("REQUESTS_LOADED")<{ requests: JoinRequest[] }>();
/** The requests could not be loaded (no answer, or the app could not reach them). */
const loadFailed = event("LOAD_FAILED")<{ message: string }>();
/** The Admin taps Accept all as Viewers; only the people on screen at the tap are answered. */
const acceptAllAsViewers = event("ACCEPT_ALL_AS_VIEWERS")<{
  folderId: string;
  requesterKeys: string[];
}>();
/** The Admin taps Accept on the Accept all sheet. */
const confirmAcceptAll = event("CONFIRM_ACCEPT_ALL")();
/** The Admin cancels the Accept all sheet, taps outside it, or leaves the page; nobody is answered. */
const cancelAcceptAll = event("CANCEL_ACCEPT_ALL")();
/** Everyone in the batch is in as a Viewer; the view says how many in one toast. */
export const allAcceptedAsViewers = event("ALL_ACCEPTED_AS_VIEWERS")<{ count: number }>();
/** Asks this phone had not listed before came in with a reload; never sent for asks already waiting at the first load. */
export const requestsArrived = event("REQUESTS_ARRIVED")<{ requests: JoinRequest[] }>();
/** The person taps Decline, Accept as Viewer ("reader") or Accept as Collaborator / Accept ("member") on a request. */
const respond = event("RESPOND")<{
  folderId: string;
  requesterKey: string;
  approve: boolean;
  role: "reader" | "member";
}>();
/** The answer was sent. */
const responded = event("RESPONDED")<{ folderId: string; requesterKey: string }>();
/** The joiner cancelled before the answer; the card leaves and the Admin is told. */
const requestWasCancelled = event("REQUEST_WAS_CANCELLED")<{
  folderId: string;
  requesterKey: string;
}>();
/** The Admin answered a request its joiner had already cancelled; the view says who cancelled. */
export const requestCancelledBeforeAnswer = event("REQUEST_CANCELLED_BEFORE_ANSWER")<{
  requesterName: string;
}>();
/** The answer could not be sent. */
const respondFailed = event("RESPOND_FAILED")<{ message: string }>();
/** The Yes or No went through; the view scrolls to the new member row (Accept) or toasts the outcome (Decline). */
export const answerSent = event("ANSWER_SENT")<{
  requesterKey: string;
  requesterName: string;
  approve: boolean;
  role: "reader" | "member";
  viaInvite: boolean;
}>();
/** The Admin taps Decline: the card leaves the list at once but nothing is sent yet, so the toast can offer Undo. */
const holdDecline = event("HOLD_DECLINE")<{ folderId: string; requesterKey: string }>();
/** The Admin taps Undo on the Declined toast: the card comes back exactly as it was. */
const undoDecline = event("UNDO_DECLINE")<{ folderId: string; requesterKey: string }>();
/** The Declined toast closed and the No was sent; the held request is forgotten. */
const declineSent = event("DECLINE_SENT")<{ folderId: string; requesterKey: string }>();
/** The held No could not be sent; the card comes back so the Admin can answer again. */
const declineFailed = event("DECLINE_FAILED")<{ folderId: string; requesterKey: string }>();
/** A held No could not be sent and the card is back; the view says so. */
export const declineNotSent = event("DECLINE_NOT_SENT")<{ requesterName: string }>();
/** A Decline is held; the view says who with an Undo on the toast. */
export const declineHeld = event("DECLINE_HELD")<{
  folderId: string;
  requesterKey: string;
  requesterName: string;
}>();
/** The person taps Try again after an error, or Retry after a failed answer (the same answer is sent again). */
const retry = event("RETRY")();

type RequestsContext = {
  pendingRespond: {
    folderId: string;
    requesterKey: string;
    approve: boolean;
    role: "reader" | "member";
  } | null;
  requests: JoinRequest[];
  /** A list has been loaded at least once, so a later new ask is news. */
  loadedOnce: boolean;
  error: string | null;
  /** The Accept all answer that failed, kept so Retry carries on with the rest. */
  stoppedBatch: Batch | null;
  /** Declines waiting for their toast to close, with where each card sat. */
  heldDeclines: { request: JoinRequest; index: number }[];
};

const initialContext: RequestsContext = {
  pendingRespond: null,
  requests: [],
  loadedOnce: false,
  error: null,
  stoppedBatch: null,
  heldDeclines: [],
};

/** The error code the backend gives when the joiner cancelled the request. */
export const REQUEST_CANCELLED_CODE = "justus.photos/request-cancelled";

function codeOf(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    return typeof error.code === "string" ? error.code : "";
  }
  return "";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

/** The same ask: one person, one album, one time of asking (a re-ask after a No differs). */
function sameAsk(a: JoinRequest, b: JoinRequest): boolean {
  return (
    a.folderId === b.folderId &&
    a.requesterKey === b.requesterKey &&
    a.requestedAt === b.requestedAt
  );
}

function sameKey(r: JoinRequest, p: { folderId: string; requesterKey: string }): boolean {
  return r.folderId === p.folderId && r.requesterKey === p.requesterKey;
}

function restoreHeld(
  context: { get: () => RequestsContext; set: (c: RequestsContext) => void },
  key: { folderId: string; requesterKey: string },
) {
  const ctx = context.get();
  const held = ctx.heldDeclines.find((h) => sameKey(h.request, key));
  if (!held) return null;
  const requests = [...ctx.requests];
  requests.splice(Math.min(held.index, requests.length), 0, held.request);
  context.set({ ...ctx, requests, heldDeclines: ctx.heldDeclines.filter((h) => h !== held) });
  return held;
}

const nameOf = stateNameOf(REQUESTS_STATES);

/** The requests inbox view model as a pure function of the actor snapshot. */
export function requestsViewModel(s: Snapshot<RequestsContext>) {
  const state = nameOf(s);
  const fatal = fatalErrorOf(s);
  return {
    requests: s.context.requests,
    state,
    /** A reload is under way; a tap now would be dropped, so the buttons wait. */
    loading: state === "loadingRequests",
    responding:
      state === "sendingAnswer" ||
      state === "sendingAnswersToAll" ||
      state === "confirmingAcceptAll",
    /** The people the Accept all sheet names, or null when it is closed. */
    acceptAllSheet: state === "confirmingAcceptAll" ? (s.payload as AcceptAllSheet) : null,
    failedAnswer: state === "couldNotSendAnswer" ? s.context.pendingRespond : null,
    settled: state === "showingRequests" || state === "couldNotSendAnswer",
    error: fatal?.message ?? s.context.error,
    fatal: fatal !== null,
  };
}

type RequestsPort = Pick<typeof gateway, "requests" | "respond">;

/** The clock and the gateway are injected so tests and the flow inspector can drive the machine. */
export function createRequestsActor(options: { clock: Clock; gateway?: RequestsPort }) {
  const { clock, gateway: port = gateway } = options;
  return Actor({
    inputs: [
      refresh,
      respond,
      retry,
      acceptAllAsViewers,
      confirmAcceptAll,
      cancelAcceptAll,
      holdDecline,
      undoDecline,
      declineSent,
      declineFailed,
    ],
    internal: [loaded, loadFailed, responded, respondFailed, requestWasCancelled],
    outputs: [
      answerSent,
      allAcceptedAsViewers,
      requestsArrived,
      requestCancelledBeforeAnswer,
      declineHeld,
      declineNotSent,
    ],
    states: [
      requestsNotLoaded,
      loadingRequests,
      showingRequests,
      confirmingAcceptAll,
      sendingAnswer,
      sendingAnswersToAll,
      couldNotLoadRequests,
      couldNotSendAnswer,
    ],
    initial: requestsNotLoaded,
    clock,
    context: initialContext,
    setup: (m) => {
      // Decline, Undo and the held No finishing work in every state, so a tap on a toast is never lost.
      for (const at of [
        showingRequests,
        couldNotSendAnswer,
        sendingAnswer,
        sendingAnswersToAll,
        loadingRequests,
        confirmingAcceptAll,
        couldNotLoadRequests,
      ]) {
        /** The Admin tapped Decline: the card leaves the list at once, the state stays, and the toast offers Undo. */
        m.on(at, {
          event: holdDecline,
          to: [],
          handler: (e, opts) => {
            const ctx = opts.context.get();
            const index = ctx.requests.findIndex((r) => sameKey(r, e.payload));
            const request = ctx.requests[index];
            if (!request) return {};
            opts.context.set({
              ...ctx,
              requests: removeRequestFromList(
                ctx.requests,
                e.payload.folderId,
                e.payload.requesterKey,
              ),
              heldDeclines: [...ctx.heldDeclines, { request, index }],
            });
            return {
              emit: [
                declineHeld.create({
                  ...e.payload,
                  requesterName: request.requesterName,
                }),
              ],
            };
          },
        });
        /** Undo brings the card back at its old place; the state stays as it is, so nothing in flight is sent again. */
        m.on(at, {
          event: undoDecline,
          to: [],
          handler: (e, opts) => {
            restoreHeld(opts.context, e.payload);
            return {};
          },
        });
        /** The held No could not be sent: the card comes back and the Admin is told. */
        m.on(at, {
          event: declineFailed,
          to: [],
          handler: (e, opts) => {
            const held = restoreHeld(opts.context, e.payload);
            return held
              ? { emit: [declineNotSent.create({ requesterName: held.request.requesterName })] }
              : {};
          },
        });
        /** The held No went through; it is forgotten and the state stays as it is. */
        m.on(at, {
          event: declineSent,
          to: [],
          handler: (e, opts) => {
            const ctx = opts.context.get();
            opts.context.set({
              ...ctx,
              heldDeclines: ctx.heldDeclines.filter((h) => !sameKey(h.request, e.payload)),
            });
            return {};
          },
        });
      }
      /** The first load starts and any old error is cleared. */
      m.on(requestsNotLoaded, {
        event: refresh,
        to: [loadingRequests],
        handler: (_e, opts) => {
          opts.context.set({
            ...opts.context.get(),
            error: null,
            pendingRespond: null,
            stoppedBatch: null,
          });
          return { state: loadingRequests };
        },
      });
      for (const at of [showingRequests, couldNotSendAnswer]) {
        /** A reload starts and any old error is cleared. */
        m.on(at, {
          event: refresh,
          to: [loadingRequests],
          handler: (_e, opts) => {
            opts.context.set({
              ...opts.context.get(),
              error: null,
              pendingRespond: null,
              stoppedBatch: null,
            });
            return { state: loadingRequests };
          },
        });
        /** Sending the Yes or No starts and any earlier error is cleared. */
        m.on(at, {
          event: respond,
          to: [sendingAnswer],
          handler: (e, opts) => {
            opts.context.set({
              ...opts.context.get(),
              error: null,
              stoppedBatch: null,
              pendingRespond: {
                folderId: e.payload.folderId,
                requesterKey: e.payload.requesterKey,
                approve: e.payload.approve,
                role: e.payload.role,
              },
            });
            return { state: sendingAnswer };
          },
        });
        /** Accept all as Viewers opens the sheet with the people on screen at the tap who are still waiting in that album; with none, nothing happens. */
        m.on(at, {
          event: acceptAllAsViewers,
          to: [confirmingAcceptAll],
          handler: (e, opts) => {
            const ctx = opts.context.get();
            const keys = [...new Set(e.payload.requesterKeys)].filter((k) =>
              ctx.requests.some((r) => r.folderId === e.payload.folderId && r.requesterKey === k),
            );
            if (keys.length === 0) return {};
            opts.context.set({ ...ctx, error: null, pendingRespond: null, stoppedBatch: null });
            return {
              state: confirmingAcceptAll.create({
                folderId: e.payload.folderId,
                requesterKeys: keys,
              }),
            };
          },
        });
      }
      /** Accept on the sheet: the listed people are answered one by one. */
      m.on(confirmingAcceptAll, {
        event: confirmAcceptAll,
        to: [sendingAnswersToAll],
        handler: (_e, opts) => {
          const [next, ...after] = opts.state.payload.requesterKeys;
          if (next === undefined) return {};
          return {
            state: sendingAnswersToAll.create({
              folderId: opts.state.payload.folderId,
              next,
              after,
              sent: 0,
            }),
          };
        },
      });
      /** Cancel on the sheet: nobody is answered, and the list reloads. */
      m.on(confirmingAcceptAll, {
        event: cancelAcceptAll,
        to: [loadingRequests],
        handler: () => ({ state: loadingRequests }),
      });
      /** A reload after an error starts and the error message goes away. */
      m.on(couldNotLoadRequests, {
        event: refresh,
        to: [loadingRequests],
        handler: (_e, opts) => {
          opts.context.set({
            ...opts.context.get(),
            error: null,
            pendingRespond: null,
            stoppedBatch: null,
          });
          return { state: loadingRequests };
        },
      });
      /** Try again after an error: loading starts again and the error message goes away. */
      m.on(couldNotLoadRequests, {
        event: retry,
        to: [loadingRequests],
        handler: (_e, opts) => {
          opts.context.set({
            ...opts.context.get(),
            error: null,
            pendingRespond: null,
            stoppedBatch: null,
          });
          return { state: loadingRequests };
        },
      });

      /** The pending join requests are fetched; if that fails or returns nothing, loading fails and the person sees an error. */
      m.effect(loadingRequests, {
        name: "loadingRequests",
        sends: [loaded, loadFailed],
        fn: ({ signal, emit }) => {
          return runInvoke(
            signal,
            () => port.requests(),
            (result) => {
              const requests = (result as { requests?: JoinRequest[] } | null)?.requests;
              if (!requests) {
                emit(loadFailed.create({ message: "requests returned no data" }));
                return;
              }
              emit(loaded.create({ requests }));
            },
            (message) => emit(loadFailed.create({ message })),
          );
        },
      });
      /** The requests are shown; asks not listed before are announced, except at the first load. */
      m.on(loadingRequests, {
        event: loaded,
        to: [showingRequests],
        handler: (e, opts) => {
          const ctx = opts.context.get();
          const listed = e.payload.requests.filter(
            (r) => !ctx.heldDeclines.some((h) => sameKey(h.request, r)),
          );
          const fresh = listed.filter((r) => !ctx.requests.some((q) => sameAsk(q, r)));
          opts.context.set({ ...ctx, requests: listed, error: null, loadedOnce: true });
          if (ctx.loadedOnce && fresh.length > 0) {
            return { state: showingRequests, emit: [requestsArrived.create({ requests: fresh })] };
          }
          return { state: showingRequests };
        },
      });
      /** Loading failed: the person sees an error and can try again. */
      m.on(loadingRequests, {
        event: loadFailed,
        to: [couldNotLoadRequests],
        handler: (e, opts) => {
          opts.context.set({ ...opts.context.get(), error: e.payload.message });
          return { state: couldNotLoadRequests };
        },
      });

      /** The Admin's answer to a join request is sent; if it cannot be sent, the person sees an error and the request stays in the list. */
      m.effect(sendingAnswer, {
        name: "sendingAnswer",
        sends: [responded, respondFailed, requestWasCancelled],
        fn: ({ signal, emit, context }) => {
          const pending = context.get().pendingRespond;
          if (!pending) {
            emit(respondFailed.create({ message: "no pending response" }));
            return;
          }
          const { folderId, requesterKey } = pending;
          return (async () => {
            try {
              const [error] = await port.respond(
                folderId,
                requesterKey,
                pending.approve,
                pending.role,
              );
              if (signal.aborted) return;
              if (!error) emit(responded.create({ folderId, requesterKey }));
              else if (codeOf(error) === REQUEST_CANCELLED_CODE)
                emit(requestWasCancelled.create({ folderId, requesterKey }));
              else emit(respondFailed.create({ message: messageOf(error) }));
            } catch (e) {
              if (signal.aborted) return;
              emit(respondFailed.create({ message: messageOf(e) }));
            }
          })();
        },
      });
      /** One answer of Accept all is sent as a Viewer; if it cannot be sent, the batch hears why. */
      m.effect(sendingAnswersToAll, {
        name: "sendingAnswersToAll",
        sends: [responded, respondFailed, requestWasCancelled],
        fn: ({ signal, emit, state }) => {
          const { folderId, next } = state.payload;
          return (async () => {
            try {
              const [error] = await port.respond(folderId, next, true, "reader");
              if (signal.aborted) return;
              if (!error) emit(responded.create({ folderId, requesterKey: next }));
              else if (codeOf(error) === REQUEST_CANCELLED_CODE)
                emit(requestWasCancelled.create({ folderId, requesterKey: next }));
              else emit(respondFailed.create({ message: messageOf(error) }));
            } catch (e) {
              if (signal.aborted) return;
              emit(respondFailed.create({ message: messageOf(e) }));
            }
          })();
        },
      });
      /** One answer of Accept all went through: that person leaves the list and the next is sent; after the last, the list reloads and the Admin hears how many are in. */
      m.on(sendingAnswersToAll, {
        event: responded,
        to: [sendingAnswersToAll, loadingRequests],
        handler: (e, opts) => {
          const ctx = opts.context.get();
          const p = opts.state.payload;
          opts.context.set({
            ...ctx,
            requests: removeRequestFromList(
              ctx.requests,
              e.payload.folderId,
              e.payload.requesterKey,
            ),
          });
          const sent = p.sent + 1;
          const [next, ...after] = p.after;
          if (next !== undefined) {
            return { state: sendingAnswersToAll.create({ ...p, next, after, sent }) };
          }
          return { state: loadingRequests, emit: [allAcceptedAsViewers.create({ count: sent })] };
        },
      });
      /** A person in Accept all cancelled: they are skipped, the rest go on, and only who got in is counted. */
      m.on(sendingAnswersToAll, {
        event: requestWasCancelled,
        to: [sendingAnswersToAll, loadingRequests],
        handler: (e, opts) => {
          const ctx = opts.context.get();
          const p = opts.state.payload;
          opts.context.set({
            ...ctx,
            requests: removeRequestFromList(
              ctx.requests,
              e.payload.folderId,
              e.payload.requesterKey,
            ),
          });
          const [next, ...after] = p.after;
          if (next !== undefined) {
            return { state: sendingAnswersToAll.create({ ...p, next, after }) };
          }
          return {
            state: loadingRequests,
            emit: p.sent > 0 ? [allAcceptedAsViewers.create({ count: p.sent })] : [],
          };
        },
      });
      /** One answer of Accept all failed: the batch stops, the rest stay waiting, and Retry carries on from this person. */
      m.on(sendingAnswersToAll, {
        event: respondFailed,
        to: [couldNotSendAnswer],
        handler: (e, opts) => {
          const p = opts.state.payload;
          opts.context.set({
            ...opts.context.get(),
            error: e.payload.message,
            stoppedBatch: p,
            pendingRespond: {
              folderId: p.folderId,
              requesterKey: p.next,
              approve: true,
              role: "reader",
            },
          });
          return { state: couldNotSendAnswer };
        },
      });
      /** The answer went through and that request disappears from the list. */
      m.on(sendingAnswer, {
        event: responded,
        to: [showingRequests],
        handler: (e, opts) => {
          const ctx = opts.context.get();
          const pending = ctx.pendingRespond;
          const request = ctx.requests.find(
            (q) => q.folderId === e.payload.folderId && q.requesterKey === e.payload.requesterKey,
          );
          opts.context.set({
            ...ctx,
            error: null,
            requests: removeRequestFromList(
              ctx.requests,
              e.payload.folderId,
              e.payload.requesterKey,
            ),
            pendingRespond: null,
          });
          if (!pending) return { state: showingRequests };
          return {
            state: showingRequests,
            emit: [
              answerSent.create({
                requesterKey: e.payload.requesterKey,
                requesterName: request?.requesterName ?? copy("requests.they"),
                approve: pending.approve,
                role: pending.role,
                viaInvite: request?.viaInvite === true,
              }),
            ],
          };
        },
      });
      /** The joiner cancelled: the card leaves and the Admin is told who. */
      m.on(sendingAnswer, {
        event: requestWasCancelled,
        to: [showingRequests],
        handler: (e, opts) => {
          const ctx = opts.context.get();
          const request = ctx.requests.find(
            (q) => q.folderId === e.payload.folderId && q.requesterKey === e.payload.requesterKey,
          );
          opts.context.set({
            ...ctx,
            error: null,
            requests: removeRequestFromList(
              ctx.requests,
              e.payload.folderId,
              e.payload.requesterKey,
            ),
            pendingRespond: null,
          });
          return {
            state: showingRequests,
            emit: [
              requestCancelledBeforeAnswer.create({
                requesterName: request?.requesterName || copy("requests.they"),
              }),
            ],
          };
        },
      });
      /** Sending failed: the person sees an error and the request stays in the list. */
      m.on(sendingAnswer, {
        event: respondFailed,
        to: [couldNotSendAnswer],
        handler: (e, opts) => {
          opts.context.set({
            ...opts.context.get(),
            error: e.payload.message,
          });
          return { state: couldNotSendAnswer };
        },
      });
      /** Retry after a failed answer: the same answer is sent again, and a stopped Accept all carries on with the people still waiting. */
      m.on(couldNotSendAnswer, {
        event: retry,
        to: [sendingAnswer, sendingAnswersToAll],
        handler: (_e, opts) => {
          const ctx = opts.context.get();
          opts.context.set({ ...ctx, error: null, stoppedBatch: null });
          if (ctx.stoppedBatch) return { state: sendingAnswersToAll.create(ctx.stoppedBatch) };
          return { state: sendingAnswer };
        },
      });
    },
  });
}

export const requestsActor = createRequestsActor({ clock: RealClock() });

export const requests = {
  state: () => nameOf(requestsActor.snapshot()),
  refresh: () => requestsActor.send(refresh.create()),
  respond: (
    folderId: string,
    requesterKey: string,
    approve: boolean,
    role: "reader" | "member" = "member",
  ) => requestsActor.send(respond.create({ folderId, requesterKey, approve, role })),
  retry: () => requestsActor.send(retry.create()),
  /** Decline leaves the card at once; the No is sent by `sendDecline` once the toast closes. */
  holdDecline: (folderId: string, requesterKey: string) =>
    requestsActor.send(holdDecline.create({ folderId, requesterKey })),
  undoDecline: (folderId: string, requesterKey: string) =>
    requestsActor.send(undoDecline.create({ folderId, requesterKey })),
  /** Sends a held No; if it cannot be sent the card comes back. */
  sendDecline: async (folderId: string, requesterKey: string) => {
    const held = requestsActor
      .snapshot()
      .context.heldDeclines.some((h) => sameKey(h.request, { folderId, requesterKey }));
    if (!held) return;
    const [error] = await gateway.respond(folderId, requesterKey, false);
    const done = error && codeOf(error) !== REQUEST_CANCELLED_CODE ? declineFailed : declineSent;
    requestsActor.send(done.create({ folderId, requesterKey }));
  },
  acceptAllAsViewers: (folderId: string, requesterKeys: string[]) =>
    requestsActor.send(acceptAllAsViewers.create({ folderId, requesterKeys })),
  confirmAcceptAll: () => requestsActor.send(confirmAcceptAll.create()),
  cancelAcceptAll: () => requestsActor.send(cancelAcceptAll.create()),
};

/** The requests Accept all as Viewers answers in one album: invite-link asks only (only those can be Viewers), not those whose name equals a saved friend's, not phones declined earlier, in list order. */
export function viewerAcceptKeys(
  requests: (JoinRequest & { clash?: string })[],
  folderId: string,
): string[] {
  return requests
    .filter(
      (r) =>
        r.folderId === folderId &&
        r.viaInvite === true &&
        r.clash === undefined &&
        !r.declinedEarlier,
    )
    .map((r) => r.requesterKey);
}
