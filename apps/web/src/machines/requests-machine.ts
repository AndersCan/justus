import { Actor, RealClock, event, state, type Clock, type Snapshot } from "@mantaq/core";
import type { JoinRequest } from "@justus/core";
import { gateway } from "../gateway";
import { fatalErrorOf, runInvoke, stateNameOf } from "./actor-utils";
import { removeRequestFromList } from "./requests-list";

/**
 * Join-request inbox: pending "<name> wants to join <album>" requests shown
 * to this device's Admins, each with Yes/No. Same actor pattern as
 * the other machines.
 */

const REQUESTS_STATES = [
  "requestsNotLoaded",
  "loadingRequests",
  "showingRequests",
  "sendingAnswer",
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
/** The Yes or No did not reach the app; the request stays in the list. No message is shown. */
const couldNotSendAnswer = state("couldNotSendAnswer")();
/** The requests could not be loaded; the person sees the problem and can try again. */
const couldNotLoadRequests = state("couldNotLoadRequests")();

/** The person opens the requests inbox or asks it to reload. */
const refresh = event("REFRESH")();
/** The list of requests came back. */
const loaded = event("LOADED")<{ requests: JoinRequest[] }>();
/** The requests could not be loaded (no answer, or the app could not reach them). */
const loadFailed = event("LOAD_FAILED")<{ message: string }>();
/** The person taps Yes or No on a request. */
const respond = event("RESPOND")<{ folderId: string; requesterKey: string; approve: boolean }>();
/** The answer was sent. */
const responded = event("RESPONDED")<{ folderId: string; requesterKey: string }>();
/** The answer could not be sent. */
const respondFailed = event("RESPOND_FAILED")<{ message: string }>();
/** The person taps Try again after an error. */
const retry = event("RETRY")();

type RequestsContext = {
  pendingRespond: { folderId: string; requesterKey: string; approve: boolean } | null;
  requests: JoinRequest[];
  error: string | null;
};

const initialContext: RequestsContext = { pendingRespond: null, requests: [], error: null };

const nameOf = stateNameOf(REQUESTS_STATES);

/** The requests inbox view model as a pure function of the actor snapshot. */
export function requestsViewModel(s: Snapshot<RequestsContext>) {
  const state = nameOf(s);
  const fatal = fatalErrorOf(s);
  return {
    requests: s.context.requests,
    state,
    responding: state === "sendingAnswer",
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
    inputs: [refresh, respond, retry],
    internal: [loaded, loadFailed, responded, respondFailed],
    outputs: [],
    states: [
      requestsNotLoaded,
      loadingRequests,
      showingRequests,
      sendingAnswer,
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
          opts.context.set({ ...opts.context.get(), error: null });
          return { state: loadingRequests };
        },
      });
      for (const at of [showingRequests, couldNotSendAnswer]) {
        /** A reload starts and any old error is cleared. */
        m.on(at, {
          event: refresh,
          to: [loadingRequests],
          handler: (_e, opts) => {
            opts.context.set({ ...opts.context.get(), error: null });
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
              pendingRespond: {
                folderId: e.payload.folderId,
                requesterKey: e.payload.requesterKey,
                approve: e.payload.approve,
              },
            });
            return { state: sendingAnswer };
          },
        });
      }
      /** A reload after an error starts and the error message goes away. */
      m.on(couldNotLoadRequests, {
        event: refresh,
        to: [loadingRequests],
        handler: (_e, opts) => {
          opts.context.set({ ...opts.context.get(), error: null });
          return { state: loadingRequests };
        },
      });
      /** Try again after an error: loading starts again and the error message goes away. */
      m.on(couldNotLoadRequests, {
        event: retry,
        to: [loadingRequests],
        handler: (_e, opts) => {
          opts.context.set({ ...opts.context.get(), error: null });
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
            () => port.respond(pending.folderId, pending.requesterKey, pending.approve),
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
      /** The answer went through and that request disappears from the list. */
      m.on(sendingAnswer, {
        event: responded,
        to: [showingRequests],
        handler: (e, opts) => {
          opts.context.set({
            ...opts.context.get(),
            error: null,
            requests: removeRequestFromList(
              opts.context.get().requests,
              e.payload.folderId,
              e.payload.requesterKey,
            ),
            pendingRespond: null,
          });
          return { state: showingRequests };
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
            pendingRespond: null,
          });
          return { state: couldNotSendAnswer };
        },
      });
    },
  });
}

export const requestsActor = createRequestsActor({ clock: RealClock() });

export const requests = {
  state: () => nameOf(requestsActor.snapshot()),
  refresh: () => requestsActor.send(refresh.create()),
  respond: (folderId: string, requesterKey: string, approve: boolean) =>
    requestsActor.send(respond.create({ folderId, requesterKey, approve })),
  retry: () => requestsActor.send(retry.create()),
};
