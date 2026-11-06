import { Actor, event, state } from "@mantaq/core";
import type { Clock } from "@mantaq/core";
import { withTimeout } from "@mantaq/sugar";

/**
 * Proposed flow, not wired into the app yet: the Admin's side of an invite link.
 * The Admin's device is the only one that checks the clock, so a request is
 * judged when it reaches that device.
 */

export type ValidFor = "10m" | "1h" | "1d" | "7d";

export const VALID_FOR_MS: Record<ValidFor, number> = {
  "10m": 10 * 60_000,
  "1h": 60 * 60_000,
  "1d": 24 * 60 * 60_000,
  "7d": 7 * 24 * 60 * 60_000,
};

export type LinkRequest = { requesterKey: string; requesterName: string };
export type LinkInfo = { linkId: string; expiresAt: number };

/** The Admin has not made a link yet. */
const drafting = state("drafting")();
/** The link works: requests that arrive are queued for the Admin to accept or decline. */
const live = state("live")<LinkInfo>();
/** The link ran out of time. New requests are refused; ones already queued stay. */
const expired = state("expired")();
/** The Admin cancelled the link. New requests are refused; ones already queued stay. */
const cancelled = state("cancelled")();

/** The Admin makes a link that works for the chosen time. */
const create = event("create")<{ validFor: ValidFor }>();
/** The Admin cancels the link. */
const cancel = event("cancel")();
/** Someone opened the link and asked to join. */
const requestArrived = event("requestArrived")<LinkRequest>();

/** The link's time ran out. */
const expiryDue = event("expiryDue")();

/** The request is waiting in the Admin's list. */
const requestQueued = event("requestQueued")<LinkRequest>();
/** The request was turned away because the link is no longer live. */
const requestRefused = event("requestRefused")<{
  reason: "expired" | "cancelled";
  request: LinkRequest;
}>();

/** Time left until `expiresAt`; a time that is not a number counts as already passed. */
function msUntil(expiresAt: number, now: number): number {
  const left = expiresAt - now;
  return Number.isFinite(left) ? Math.max(0, left) : 0;
}

/** Everything but `clock` is optional so the flow inspector can build it from a clock alone. */
export function createInviteLinkActor(options: { clock: Clock; newLinkId?: () => string }) {
  const { clock } = options;
  let counter = 0;
  const newLinkId = options.newLinkId ?? (() => `link-${++counter}`);
  return Actor({
    inputs: [create, cancel, requestArrived],
    internal: [expiryDue],
    outputs: [requestQueued, requestRefused],
    states: [drafting, live, expired, cancelled],
    initial: drafting,
    clock,
    setup: (m) => {
      /** The Admin makes a link; it works until the chosen time has passed. */
      m.on(drafting, {
        event: create,
        to: [live],
        handler: (e) => ({
          state: live.create({
            linkId: newLinkId(),
            expiresAt: clock.now() + VALID_FOR_MS[e.payload.validFor],
          }),
        }),
      });
      /** A timer runs until the link's expiry time. */
      m.effect(live, {
        name: "untilExpiry",
        sends: [expiryDue],
        fn: (input) =>
          withTimeout(msUntil(input.state.payload.expiresAt, clock.now()), {
            input,
            event: () => expiryDue.create(),
          }),
      });
      /** A request arrives while the link works, so it is queued for the Admin. */
      m.on(live, {
        event: requestArrived,
        to: [live],
        handler: (e, { actor }) => {
          const { payload } = actor.snapshot();
          return {
            state: live.create(payload as LinkInfo),
            emit: [requestQueued.create(e.payload)],
          };
        },
      });
      /** The time ran out, so the link stops working. */
      m.on(live, { event: expiryDue, to: [expired], handler: () => ({ state: expired }) });
      /** The Admin cancels the link, so it stops working. */
      m.on(live, { event: cancel, to: [cancelled], handler: () => ({ state: cancelled }) });
      /** A request arrives after the link expired, so it is refused. */
      m.on(expired, {
        event: requestArrived,
        to: [expired],
        handler: (e) => ({
          state: expired,
          emit: [requestRefused.create({ reason: "expired", request: e.payload })],
        }),
      });
      /** A request arrives after the Admin cancelled the link, so it is refused. */
      m.on(cancelled, {
        event: requestArrived,
        to: [cancelled],
        handler: (e) => ({
          state: cancelled,
          emit: [requestRefused.create({ reason: "cancelled", request: e.payload })],
        }),
      });
    },
  });
}
