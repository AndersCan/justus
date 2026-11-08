import { Actor, event, state } from "@mantaq/core";
import type { Clock } from "@mantaq/core";
import type { Expectations } from "@mantaq/inspect";
import { withTimeout } from "@mantaq/sugar";
import { runInvoke } from "../actor-utils";

/**
 * The owner's invite panel: pick how long a link works, make it, and see when it ends.
 * The end time travels inside the link; only the joiner's phone checks it, so this
 * machine only keeps the panel honest. It lives in the running app, nothing is saved.
 */

export type ValidFor = "10m" | "1h" | "12h" | "1d" | "7d" | "noEnd";

/** The times a link can end after; "noEnd" has none. */
export type EndingValidFor = Exclude<ValidFor, "noEnd">;

export const VALID_FOR_MS: Record<EndingValidFor, number> = {
  "10m": 10 * 60_000,
  "1h": 60 * 60_000,
  "12h": 12 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
  "7d": 7 * 24 * 60 * 60_000,
};

export const VALID_FOR_LABEL: Record<ValidFor, string> = {
  "10m": "10 minutes",
  "1h": "1 hour",
  "12h": "12 hours",
  "1d": "1 day",
  "7d": "7 days",
  noEnd: "Until I turn it off",
};

const isValidFor = (v: string): v is ValidFor => v in VALID_FOR_LABEL;

type InviteLinkContext = {
  /** The album the link is for. */
  folderId: string;
  /** How long a new link works: 10 minutes, 1 hour, 12 hours, 1 day, 7 days, or until the owner turns it off. */
  validFor: ValidFor;
  /** The album's code that was just turned off; no link is made with it again. */
  offCode: string;
  /** The album whose links were just turned off; its panel says so until a link is made for it. Empty when none. */
  offFolderId: string;
};

/** Turning links off, as the gateway answers it. */
export type InviteLinkPort = { turnOff(folderId: string): Promise<[unknown, unknown]> };

const noPort: InviteLinkPort = { turnOff: async () => [undefined, {}] };

/** No link has been made yet; the panel shows the time picker. */
const noLinkYet = state("noLinkYet")();
/**
 * The owner picked "Until I turn it off" and tapped Send or Copy. The panel asks first:
 * "Anyone who gets this link can ask to join until you turn it off. You still say yes to each person."
 */
const confirmingNoEnd = state("confirmingNoEnd")<{ folderId: string; code: string }>();
/** A link was made and works until `expiresAt` (ms since the epoch, whole seconds). */
const linkMade = state("linkMade")<{ expiresAt: number }>();
/** A link with no end time was made; it works until the owner turns links off. Turn off stays on the panel. */
const linkWorksUntilTurnedOff = state("linkWorksUntilTurnedOff")();
/** The link shown before turning off: its end time, or none for a link with no end. */
type ShownLink = { expiresAt?: number };
/** The owner confirmed turning off the links; `before` is the link shown until then, if any. */
const turningOff = state("turningOff")<{
  folderId: string;
  code: string;
  before?: ShownLink;
}>();

/** The owner picks how long the link works. */
export const chooseLinkTime = event("chooseLinkTime")<{
  /** How long the link works. */
  validFor: ValidFor;
}>();
/** The owner taps Send or Copy for an album. */
export const createLink = event("createLink")<{
  /** The album to make the link for. */
  folderId: string;
  /** The album's current invite code. */
  code: string;
}>();
/** The owner confirmed turning off every link sent for an album; `code` is the album's current one. */
export const turnOffLink = event("turnOffLink")<{
  /** The album whose links are turned off. */
  folderId: string;
  /** The album's current invite code. */
  code: string;
}>();

/** The owner taps "Make link" on the no-end question. */
export const confirmNoEnd = event("confirmNoEnd")();
/** The owner taps "Pick an end time" on the no-end question; nothing is made. */
export const pickEndTime = event("pickEndTime")();

/** The link's time ran out. */
const timeRanOut = event("timeRanOut")();
/** The album's links were turned off. */
const linkOff = event("linkOff")<{ folderId: string; code: string }>();
/** Turning the links off failed. */
const linkOffFailed = event("linkOffFailed")<{ folderId: string }>();

/** Tells the owner the links are off. */
const linkTurnedOff = event("linkTurnedOff")<{ folderId: string }>();
/** Tells the owner the links could not be turned off. */
const turnOffFailed = event("turnOffFailed")<{ folderId: string }>();

/** Time left until `expiresAt`; a time that is not a number counts as already passed. */
function msUntil(expiresAt: number, now: number): number {
  const left = expiresAt - now;
  return Number.isFinite(left) ? Math.max(0, left) : 0;
}

/** Everything but `clock` is optional so the flow inspector can build it from a clock alone. */
export function createInviteLinkActor(options: { clock: Clock; port?: InviteLinkPort }) {
  const { clock, port = noPort } = options;
  /** The panel after a link is made: with an end time, or with none. */
  const shown = (link: ShownLink) =>
    link.expiresAt === undefined
      ? linkWorksUntilTurnedOff
      : linkMade.create({ expiresAt: link.expiresAt });
  return Actor({
    inputs: [chooseLinkTime, createLink, confirmNoEnd, pickEndTime, turnOffLink],
    internal: [timeRanOut, linkOff, linkOffFailed],
    outputs: [linkTurnedOff, turnOffFailed],
    states: [noLinkYet, confirmingNoEnd, linkMade, linkWorksUntilTurnedOff, turningOff],
    initial: noLinkYet,
    clock,
    context: { folderId: "", validFor: "1d", offCode: "", offFolderId: "" } as InviteLinkContext,
    setup: (m) => {
      /** A made link for the chosen time; a link with no end asks first. */
      const make = (
        e: { payload: { folderId: string; code: string } },
        context: { get(): InviteLinkContext; set(c: InviteLinkContext): void },
      ) => {
        const current = context.get();
        context.set({
          ...current,
          folderId: e.payload.folderId,
          offFolderId: current.offFolderId === e.payload.folderId ? "" : current.offFolderId,
        });
        if (current.validFor === "noEnd") return { state: confirmingNoEnd.create(e.payload) };
        const expiresAt = Math.floor((clock.now() + VALID_FOR_MS[current.validFor]) / 1000) * 1000;
        return { state: linkMade.create({ expiresAt }) };
      };
      for (const at of [noLinkYet, linkMade, linkWorksUntilTurnedOff]) {
        /** The owner picks a time; a value that is not one of the choices is ignored. The panel for another album shows the picker, so a pick counts while a link is shown too. */
        m.on(at, {
          event: chooseLinkTime,
          handler: (e, { context }) => {
            if (isValidFor(e.payload.validFor))
              context.set({ ...context.get(), validFor: e.payload.validFor });
            return {};
          },
        });
        /** The owner turns off the links; a shown link stays shown until the answer comes. */
        m.on(at, {
          event: turnOffLink,
          to: [turningOff],
          handler: (e, { state }) => {
            if (e.payload.folderId === "" || e.payload.code === "") return {};
            if (state.name === "noLinkYet") return { state: turningOff.create(e.payload) };
            const before: ShownLink =
              state.name === "linkMade"
                ? { expiresAt: (state.payload as { expiresAt: number }).expiresAt }
                : {};
            return { state: turningOff.create({ ...e.payload, before }) };
          },
        });
      }
      /** The owner makes a link that works for the chosen time. */
      m.on(noLinkYet, {
        event: createLink,
        to: [linkMade, confirmingNoEnd],
        handler: (e, { context }) => {
          // The code was just turned off; wait for the album's new one.
          if (e.payload.folderId === "" || e.payload.code === context.get().offCode) return {};
          return make(e, context);
        },
      });
      for (const at of [linkMade, linkWorksUntilTurnedOff]) {
        /** A link for another album replaces the one made; the same album keeps its link. */
        m.on(at, {
          event: createLink,
          to: [linkMade, confirmingNoEnd],
          handler: (e, { context }) => {
            if (e.payload.folderId === "" || e.payload.folderId === context.get().folderId)
              return {};
            return make(e, context);
          },
        });
      }
      /** "Make link": the link carries no end time. */
      m.on(confirmingNoEnd, {
        event: confirmNoEnd,
        to: [linkWorksUntilTurnedOff],
        handler: () => ({ state: linkWorksUntilTurnedOff }),
      });
      /** "Pick an end time": back to the picker, nothing made. */
      m.on(confirmingNoEnd, {
        event: pickEndTime,
        to: [noLinkYet],
        handler: (_e, { context }) => {
          context.set({ ...context.get(), validFor: "1d" });
          return { state: noLinkYet };
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
      /** The links are turned off on this phone. */
      m.effect(turningOff, {
        name: "turnOff",
        sends: [linkOff, linkOffFailed],
        fn: ({ signal, emit, state }) => {
          const { folderId, code } = state.payload;
          return runInvoke(
            signal,
            () => port.turnOff(folderId),
            () => emit(linkOff.create({ folderId, code })),
            () => emit(linkOffFailed.create({ folderId })),
          );
        },
      });
      /** Done: another album's link stays shown, otherwise the panel offers the picker. */
      m.on(turningOff, {
        event: linkOff,
        to: [noLinkYet, linkMade, linkWorksUntilTurnedOff],
        handler: (e, { context, state }) => {
          const current = context.get();
          const { before } = state.payload as { before?: ShownLink };
          const keep = before !== undefined && e.payload.folderId !== current.folderId;
          context.set({
            ...current,
            offCode: e.payload.code,
            offFolderId: e.payload.folderId,
            validFor: keep ? current.validFor : "1d",
          });
          return {
            state: keep ? shown(before) : noLinkYet,
            emit: [linkTurnedOff.create({ folderId: e.payload.folderId })],
          };
        },
      });
      /** Failed: the panel goes back to what it showed. */
      m.on(turningOff, {
        event: linkOffFailed,
        to: [noLinkYet, linkMade, linkWorksUntilTurnedOff],
        handler: (e, { state }) => {
          const { before } = state.payload as { before?: ShownLink };
          return {
            state: before ? shown(before) : noLinkYet,
            emit: [turnOffFailed.create({ folderId: e.payload.folderId })],
          };
        },
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
