import { Actor, event, state } from "@mantaq/core";
import type { Clock } from "@mantaq/core";
import type { Expectations } from "@mantaq/inspect";
import { withTimeout } from "@mantaq/sugar";
import { runInvoke } from "../actor-utils";

import { copy } from "../../copy/copy";
/**
 * The owner's invite panel: pick how long a link works, make it, and see when it ends.
 * The end time travels inside the link for the joiner's phone, and is saved on this phone,
 * which turns away asks sent after every link has ended.
 */

export type ValidFor = "10m" | "1h" | "1d" | "7d";

export const VALID_FOR_MS: Record<ValidFor, number> = {
  "10m": 10 * 60_000,
  "1h": 60 * 60_000,
  "1d": 24 * 60 * 60_000,
  "7d": 7 * 24 * 60 * 60_000,
};

export const VALID_FOR_LABEL: Record<ValidFor, string> = {
  "10m": copy("invite_link.10_minutes"),
  "1h": copy("invite_link.1_hour"),
  "1d": copy("invite_link.1_day"),
  "7d": copy("invite_link.7_days"),
};

type InviteLinkContext = {
  /** The album the link is for. */
  folderId: string;
  /** How long a new link works: 10 minutes, 1 hour, 1 day or 7 days. */
  validFor: ValidFor;
  /** The album's code that was just turned off; no link is made with it again. */
  offCode: string;
  /** The album whose links were just turned off; its panel says so until a link is made for it. Empty when none. */
  offFolderId: string;
};

/** Turning links off, as the gateway answers it. */
export type InviteLinkPort = {
  turnOff(folderId: string): Promise<[unknown, unknown]>;
  /** Saves the link's end time on this phone. */
  saveLinkTime(folderId: string, expiresAt: number): Promise<[unknown, unknown]>;
};

const noPort: InviteLinkPort = {
  turnOff: async () => [undefined, {}],
  saveLinkTime: async () => [undefined, {}],
};

/** No link has been made yet; the panel shows the time picker. */
const noLinkYet = state("noLinkYet")();
/** The link's end time is being saved on this phone; the link is not handed out until it is. */
const savingLinkTime = state("savingLinkTime")<{ expiresAt: number }>();
/** A link was made and works until `expiresAt` (ms since the epoch, whole seconds). */
const linkMade = state("linkMade")<{ expiresAt: number }>();
/** The owner confirmed turning off the links; `before` is the link shown until then, if any. */
const turningOff = state("turningOff")<{
  folderId: string;
  code: string;
  before?: { expiresAt: number };
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

/** The link's time ran out. */
const timeRanOut = event("timeRanOut")();
/** The album's links were turned off. */
const linkOff = event("linkOff")<{ folderId: string; code: string }>();
/** The link's time is saved on this phone. */
const linkTimeSaved = event("linkTimeSaved")();
/** Saving the link's time on this phone failed. */
const linkTimeNotSaved = event("linkTimeNotSaved")();
/** Turning the links off failed. */
const linkOffFailed = event("linkOffFailed")<{ folderId: string }>();

/** Tells the owner the links are off. */
const linkTurnedOff = event("linkTurnedOff")<{ folderId: string }>();
/** Tells the owner the link could not be made. */
const linkNotSaved = event("linkNotSaved")();
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
  return Actor({
    inputs: [chooseLinkTime, createLink, turnOffLink],
    internal: [timeRanOut, linkOff, linkOffFailed, linkTimeSaved, linkTimeNotSaved],
    outputs: [linkTurnedOff, turnOffFailed, linkNotSaved],
    states: [noLinkYet, savingLinkTime, linkMade, turningOff],
    initial: noLinkYet,
    clock,
    context: { folderId: "", validFor: "1d", offCode: "", offFolderId: "" } as InviteLinkContext,
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
        to: [savingLinkTime],
        handler: (e, { context }) => {
          const current = context.get();
          // The code was just turned off; wait for the album's new one.
          if (e.payload.folderId === "" || e.payload.code === current.offCode) return {};
          context.set({
            ...current,
            folderId: e.payload.folderId,
            offFolderId: current.offFolderId === e.payload.folderId ? "" : current.offFolderId,
          });
          const expiresAt =
            Math.floor((clock.now() + VALID_FOR_MS[current.validFor]) / 1000) * 1000;
          return { state: savingLinkTime.create({ expiresAt }) };
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
        to: [savingLinkTime],
        handler: (e, { context }) => {
          const current = context.get();
          if (e.payload.folderId === "" || e.payload.folderId === current.folderId) return {};
          context.set({
            ...current,
            folderId: e.payload.folderId,
            offFolderId: current.offFolderId === e.payload.folderId ? "" : current.offFolderId,
          });
          const expiresAt =
            Math.floor((clock.now() + VALID_FOR_MS[current.validFor]) / 1000) * 1000;
          return { state: savingLinkTime.create({ expiresAt }) };
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
      /** The link's time is saved on this phone before the link is handed out. */
      m.effect(savingLinkTime, {
        name: "saveLinkTime",
        sends: [linkTimeSaved, linkTimeNotSaved],
        fn: ({ signal, emit, state, context }) => {
          const { expiresAt } = state.payload;
          return runInvoke(
            signal,
            () => port.saveLinkTime(context.get().folderId, expiresAt),
            () => emit(linkTimeSaved.create()),
            () => emit(linkTimeNotSaved.create()),
          );
        },
      });
      /** Saved: the link can be handed out. */
      m.on(savingLinkTime, {
        event: linkTimeSaved,
        to: [linkMade],
        handler: (_e, { state }) => ({
          state: linkMade.create({ expiresAt: (state.payload as { expiresAt: number }).expiresAt }),
        }),
      });
      /** Saving failed, so no link is shown and the owner can try again. */
      m.on(savingLinkTime, {
        event: linkTimeNotSaved,
        to: [noLinkYet],
        handler: (_e, { context }) => {
          context.set({ ...context.get(), validFor: "1d" });
          return { state: noLinkYet, emit: [linkNotSaved.create()] };
        },
      });
      /** The owner turns off the links before any link was made here. */
      m.on(noLinkYet, {
        event: turnOffLink,
        to: [turningOff],
        handler: (e) => {
          if (e.payload.folderId === "" || e.payload.code === "") return {};
          return { state: turningOff.create(e.payload) };
        },
      });
      /** The owner turns off the links while a link is shown; it stays shown until the answer comes. */
      m.on(linkMade, {
        event: turnOffLink,
        to: [turningOff],
        handler: (e, { state }) => {
          if (e.payload.folderId === "" || e.payload.code === "") return {};
          const { expiresAt } = state.payload as { expiresAt: number };
          return { state: turningOff.create({ ...e.payload, before: { expiresAt } }) };
        },
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
        to: [noLinkYet, linkMade],
        handler: (e, { context, state }) => {
          const current = context.get();
          const { before } = state.payload as { before?: { expiresAt: number } };
          const keep = before !== undefined && e.payload.folderId !== current.folderId;
          context.set({
            ...current,
            offCode: e.payload.code,
            offFolderId: e.payload.folderId,
            validFor: keep ? current.validFor : "1d",
          });
          return {
            state: keep ? linkMade.create(before) : noLinkYet,
            emit: [linkTurnedOff.create({ folderId: e.payload.folderId })],
          };
        },
      });
      /** Failed: the panel goes back to what it showed. */
      m.on(turningOff, {
        event: linkOffFailed,
        to: [noLinkYet, linkMade],
        handler: (e, { state }) => {
          const { before } = state.payload as { before?: { expiresAt: number } };
          return {
            state: before ? linkMade.create(before) : noLinkYet,
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
