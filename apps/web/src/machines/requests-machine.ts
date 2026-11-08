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

const REQUESTS_STATES = [
  "requestsNotLoaded",
  "loadingRequests",
  "showingRequests",
  "sendingAnswer",
  "sendingAnswersToAll",
  "couldNotLoadRequests",
  "couldNotSendAnswer",
] as const;
export type RequestsStateName = (typeof REQUESTS_STATES)[number];

/** The inbox of requests to join the person's albums has not been loaded yet. */
const requestsNotLoaded = state("requestsNotLoaded")();
/** Loading the requests from people who want to join. */
const loadingRequests = state("loadingRequests")();
/** The requests are shown, each with Yes and No. */
const showingRequests = state("showingRequests")();
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
/** Everyone in the batch is in as a Viewer; the view says how many in one toast. */
export const allAcceptedAsViewers = event("ALL_ACCEPTED_AS_VIEWERS")<{ count: number }>();
/** The person taps Decline, Accept as Viewer ("reader") or Accept as Collaborator / Accept ("member") on a request. */
const respond = event("RESPOND")<{
  folderId: string;
  requesterKey: string;
  approve: boolean;
  role: "reader" | "member";
}>();
/** The answer was sent. */
const responded = event("RESPONDED")<{ folderId: string; requesterKey: string }>();
/** The answer could not be sent. */
const respondFailed = event("RESPOND_FAILED")<{ message: string }>();
/** The Yes or No went through; the view thanks the Admin with who is in and how. */
export const answerSent = event("ANSWER_SENT")<{
  requesterName: string;
  approve: boolean;
  role: "reader" | "member";
  viaInvite: boolean;
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
  error: string | null;
  /** The Accept all answer that failed, kept so Retry carries on with the rest. */
  stoppedBatch: Batch | null;
};

const initialContext: RequestsContext = {
  pendingRespond: null,
  requests: [],
  error: null,
  stoppedBatch: null,
};

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
    responding: state === "sendingAnswer" || state === "sendingAnswersToAll",
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
    inputs: [refresh, respond, retry, acceptAllAsViewers],
    internal: [loaded, loadFailed, responded, respondFailed],
    outputs: [answerSent, allAcceptedAsViewers],
    states: [
      requestsNotLoaded,
      loadingRequests,
      showingRequests,
      sendingAnswer,
      sendingAnswersToAll,
      couldNotLoadRequests,
      couldNotSendAnswer,
    ],
    initial: requestsNotLoaded,
    clock,
    context: initialContext,
    setup: (m) => {
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
        /** Accept all as Viewers starts with the people on screen at the tap who are still waiting in that album; with none, nothing happens. */
        m.on(at, {
          event: acceptAllAsViewers,
          to: [sendingAnswersToAll],
          handler: (e, opts) => {
            const ctx = opts.context.get();
            const keys = [...new Set(e.payload.requesterKeys)].filter((k) =>
              ctx.requests.some((r) => r.folderId === e.payload.folderId && r.requesterKey === k),
            );
            const [next, ...after] = keys;
            if (next === undefined) return {};
            opts.context.set({ ...ctx, error: null, pendingRespond: null, stoppedBatch: null });
            return {
              state: sendingAnswersToAll.create({
                folderId: e.payload.folderId,
                next,
                after,
                sent: 0,
              }),
            };
          },
        });
      }
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
      /** The requests are shown. */
      m.on(loadingRequests, {
        event: loaded,
        to: [showingRequests],
        handler: (e, opts) => {
          opts.context.set({ ...opts.context.get(), requests: e.payload.requests, error: null });
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
        sends: [responded, respondFailed],
        fn: ({ signal, emit, context }) => {
          const pending = context.get().pendingRespond;
          if (!pending) {
            emit(respondFailed.create({ message: "no pending response" }));
            return;
          }
          return runInvoke(
            signal,
            () =>
              port.respond(pending.folderId, pending.requesterKey, pending.approve, pending.role),
            () =>
              emit(
                responded.create({
                  folderId: pending.folderId,
                  requesterKey: pending.requesterKey,
                }),
              ),
            (message) => emit(respondFailed.create({ message })),
          );
        },
      });
      /** One answer of Accept all is sent as a Viewer; if it cannot be sent, the batch hears why. */
      m.effect(sendingAnswersToAll, {
        name: "sendingAnswersToAll",
        sends: [responded, respondFailed],
        fn: ({ signal, emit, state }) => {
          const { folderId, next } = state.payload;
          return runInvoke(
            signal,
            () => port.respond(folderId, next, true, "reader"),
            () => emit(responded.create({ folderId, requesterKey: next })),
            (message) => emit(respondFailed.create({ message })),
          );
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
                requesterName: request?.requesterName ?? copy("requests.they"),
                approve: pending.approve,
                role: pending.role,
                viaInvite: request?.viaInvite === true,
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
  acceptAllAsViewers: (folderId: string, requesterKeys: string[]) =>
    requestsActor.send(acceptAllAsViewers.create({ folderId, requesterKeys })),
};

/** The requests Accept all as Viewers answers in one album: invite-link asks only (only those can be Viewers), not those whose name equals a saved friend's, in list order. */
export function viewerAcceptKeys(
  requests: (JoinRequest & { clash?: string })[],
  folderId: string,
): string[] {
  return requests
    .filter((r) => r.folderId === folderId && r.viaInvite === true && r.clash === undefined)
    .map((r) => r.requesterKey);
}
