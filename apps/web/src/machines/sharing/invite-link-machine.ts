import { Actor, event, state } from "@mantaq/core";
import type { Clock } from "@mantaq/core";
import type { Expectations } from "@mantaq/inspect";
import { withTimeout } from "@mantaq/sugar";

/**
 * The owner's invite panel: pick how long a link works, make it, and see when it ends.
 * The end time travels inside the link; only the joiner's phone checks it, so this
 * machine only keeps the panel honest. It lives in the running app, nothing is saved.
 */

export type ValidFor = "10m" | "1h" | "1d" | "7d";

export const VALID_FOR_MS: Record<ValidFor, number> = {
  "10m": 10 * 60_000,
  "1h": 60 * 60_000,
  "1d": 24 * 60 * 60_000,
  "7d": 7 * 24 * 60 * 60_000,
};

export const VALID_FOR_LABEL: Record<ValidFor, string> = {
  "10m": "10 minutes",
  "1h": "1 hour",
  "1d": "1 day",
  "7d": "7 days",
};

type InviteLinkContext = { folderId: string; validFor: ValidFor };

/** No link has been made yet; the panel shows the time picker. */
const noLinkYet = state("noLinkYet")();
/** A link was made and works until `expiresAt` (ms since the epoch, whole seconds). */
const linkMade = state("linkMade")<{ expiresAt: number }>();

/** The owner picks how long the link works. */
export const chooseLinkTime = event("chooseLinkTime")<{ validFor: ValidFor }>();
/** The owner taps Send or Copy for an album. */
export const createLink = event("createLink")<{ folderId: string }>();

/** The link's time ran out. */
const timeRanOut = event("timeRanOut")();

/** Time left until `expiresAt`; a time that is not a number counts as already passed. */
function msUntil(expiresAt: number, now: number): number {
  const left = expiresAt - now;
  return Number.isFinite(left) ? Math.max(0, left) : 0;
}

/** Everything but `clock` is optional so the flow inspector can build it from a clock alone. */
export function createInviteLinkActor(options: { clock: Clock }) {
  const { clock } = options;
  return Actor({
    inputs: [chooseLinkTime, createLink],
    internal: [timeRanOut],
    states: [noLinkYet, linkMade],
    initial: noLinkYet,
    clock,
    context: { folderId: "", validFor: "1d" } as InviteLinkContext,
    setup: (m) => {
      /** The owner picks a time; a value that is not one of the choices is ignored. */
      m.on(noLinkYet, {
        event: chooseLinkTime,
        handler: (e, { context }) => {
          if (e.payload.validFor in VALID_FOR_MS)
            context.set({ ...context.get(), validFor: e.payload.validFor });
          return {};
        },
      });
      /** The owner makes a link that works for the chosen time. */
      m.on(noLinkYet, {
        event: createLink,
        to: [linkMade],
        handler: (e, { context }) => {
          if (e.payload.folderId === "") return {};
          const current = context.get();
          context.set({ ...current, folderId: e.payload.folderId });
          const expiresAt =
            Math.floor((clock.now() + VALID_FOR_MS[current.validFor]) / 1000) * 1000;
          return { state: linkMade.create({ expiresAt }) };
        },
      });
      /** The panel for another album shows the picker, so a pick still counts. */
      m.on(linkMade, {
        event: chooseLinkTime,
        handler: (e, { context }) => {
          if (e.payload.validFor in VALID_FOR_MS)
            context.set({ ...context.get(), validFor: e.payload.validFor });
          return {};
        },
      });
      /** A link for another album replaces the one made; the same album keeps its link. */
      m.on(linkMade, {
        event: createLink,
        to: [linkMade],
        handler: (e, { context }) => {
          const current = context.get();
          if (e.payload.folderId === "" || e.payload.folderId === current.folderId) return {};
          context.set({ ...current, folderId: e.payload.folderId });
          const expiresAt =
            Math.floor((clock.now() + VALID_FOR_MS[current.validFor]) / 1000) * 1000;
          return { state: linkMade.create({ expiresAt }) };
        },
      });
      /** A timer runs until the link's end time. */
      m.effect(linkMade, {
        name: "untilExpiry",
        sends: [timeRanOut],
        fn: (input) =>
          withTimeout(msUntil(input.state.payload.expiresAt, clock.now()), {
            input,
            event: () => timeRanOut.create(),
          }),
      });
      /** The time ran out, so the panel offers the picker again. */
      m.on(linkMade, {
        event: timeRanOut,
        to: [noLinkYet],
        handler: (_e, { context }) => {
          context.set({ ...context.get(), validFor: "1d" });
          return { state: noLinkYet };
        },
      });
    },
  });
}

/** A link can always run out. */
export const inviteLinkExpectations: Expectations<typeof createInviteLinkActor> = {
  linkMade: { mustSee: [{}] },
};
