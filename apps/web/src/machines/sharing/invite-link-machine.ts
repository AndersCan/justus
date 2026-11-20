import { Actor, event, state, machine } from "@mantaq/core";
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

/** The kind of a link from the span it was made for, within a minute of rounding and save delay; undefined when none fits. */
export function linkKindOf(link: { madeAt: number; endsAt: number }): ValidFor | undefined {
  const span = link.endsAt - link.madeAt;
  const kinds = Object.keys(VALID_FOR_MS) as ValidFor[];
  return kinds.find((k) => Math.abs(VALID_FOR_MS[k] - span) <= 60_000);
}

type InviteLinkContext = {
  /** The album the link is for. */
  folderId: string;
  /** How long a new link works: 10 minutes, 1 hour, 1 day or 7 days. */
  validFor: ValidFor;
  /** The album's code that was just turned off; no link is made with it again. */
  offCode: string;
  /** The album whose links were just turned off; its panel says so until a link is made for it. Empty when none. */
  offFolderId: string;
  /** The album whose shown link was replaced by a removal; its panel says so until a link is made for it. Empty when none. */
  replacedFolderId: string;
  /** The latest person removed, for that line. */
  removedName: string;
  /** The latest end time given to a link; a new link with the same end gets a second more. */
  lastExpiresAt: number;
};

/** Turning links off, as the gateway answers it. */
export type InviteLinkPort = {
  turnOff(folderId: string): Promise<[unknown, unknown]>;
  /** Saves the link's end time on this phone. */
  saveLinkTime(folderId: string, expiresAt: number): Promise<[unknown, unknown]>;
  /** Ends the album's link that ends at `endsAt`; its other links keep working. */
  endLink(folderId: string, endsAt: number): Promise<[unknown, unknown]>;
};

const noPort: InviteLinkPort = {
  turnOff: async () => [undefined, {}],
  saveLinkTime: async () => [undefined, {}],
  endLink: async () => [undefined, {}],
};

/** No link has been made yet; the panel shows the time picker. */
const noLinkYet = state("noLinkYet")();
/**
 * The link's end time is being saved on this phone; the link is not handed out until it is.
 * `validFor` is the choice the end time was made from.
 */
const savingLinkTime = state("savingLinkTime")<{
  expiresAt: number;
  code: string;
  validFor: ValidFor;
}>();
/** A link was made with the album's code `code` and works until `expiresAt` (ms since the epoch, whole seconds). */
const linkMade = state("linkMade")<{ expiresAt: number; code: string }>();
/** The owner confirmed turning off the links; `before` is the link shown until then, if any. */
const turningOff = state("turningOff")<{
  folderId: string;
  code: string;
  before?: { expiresAt: number; code: string };
}>();

/** The owner confirmed ending one link; `before` is the link shown until then, if any. */
const endingLink = state("endingLink")<{
  folderId: string;
  endsAt: number;
  before?: { expiresAt: number; code: string };
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
/** The owner taps "Make a new link" for an album, even while another of its links works. */
export const makeNewLink = event("makeNewLink")<{
  /** The album to make the link for. */
  folderId: string;
  /** The album's current invite code. */
  code: string;
}>();
/** The owner confirmed ending the album's link that ends at `endsAt`. */
export const endLink = event("endLink")<{
  /** The album the link belongs to. */
  folderId: string;
  /** When the link ends; names the link. */
  endsAt: number;
}>();
/** A person was removed, so the album's invite code `code` no longer works; `name` is who. */
export const linkReplaced = event("linkReplaced")<{
  /** The album the person was removed from. */
  folderId: string;
  /** The album's invite code that no longer works. */
  code: string;
  /** Who was removed. */
  name: string;
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
/** One link was ended. */
const oneLinkEnded = event("oneLinkEnded")();
/** Ending one link failed. */
const couldNotEndLink = event("couldNotEndLink")();
/** Turning the links off failed. */
const linkOffFailed = event("linkOffFailed")<{ folderId: string }>();

/** Tells the owner the links are off. */
const linkTurnedOff = event("linkTurnedOff")<{ folderId: string }>();
/** Tells the owner the link could not be made. */
const linkNotSaved = event("linkNotSaved")();
/** Tells the owner the link was ended. */
const linkEnded = event("linkEnded")<{ folderId: string; endsAt: number }>();
/** Tells the owner the link could not be ended. */
const endLinkFailed = event("endLinkFailed")<{ folderId: string }>();
/** Tells the owner the links could not be turned off. */
const turnOffFailed = event("turnOffFailed")<{ folderId: string }>();

/** Time left until `expiresAt`; a time that is not a number counts as already passed. */
function msUntil(expiresAt: number, now: number): number {
  const left = expiresAt - now;
  return Number.isFinite(left) ? Math.max(0, left) : 0;
}

/** The end of a link made now: a whole second, and not the end the previous link got, so two links made together stay two. */
function endFor(now: number, validFor: ValidFor, lastExpiresAt: number): number {
  const end = Math.floor((now + VALID_FOR_MS[validFor]) / 1000) * 1000;
  return end <= lastExpiresAt && lastExpiresAt - end < 60_000 ? lastExpiresAt + 1000 : end;
}

/** Everything but `clock` is optional so the flow inspector can build it from a clock alone. */
export const inviteLinkMachine = machine("inviteLink", {
  create: (options: { clock: Clock; port?: InviteLinkPort }) => {
    const { clock, port = noPort } = options;
    return Actor({
      inputs: [chooseLinkTime, createLink, makeNewLink, endLink, turnOffLink, linkReplaced],
      internal: [
        timeRanOut,
        linkOff,
        linkOffFailed,
        linkTimeSaved,
        linkTimeNotSaved,
        oneLinkEnded,
        couldNotEndLink,
      ],
      outputs: [linkTurnedOff, turnOffFailed, linkNotSaved, linkEnded, endLinkFailed],
      states: [noLinkYet, savingLinkTime, linkMade, turningOff, endingLink],
      initial: noLinkYet,
      clock,
      context: {
        folderId: "",
        validFor: "1d",
        offCode: "",
        offFolderId: "",
        replacedFolderId: "",
        removedName: "",
        lastExpiresAt: 0,
      } as InviteLinkContext,
      setup: (m) => {
        /** The owner picks a time in any state, the save included; a value that is not one of the choices is ignored. */
        m.onAny({
          event: chooseLinkTime,
          handler: (e, { context }) => {
            if (e.payload.validFor in VALID_FOR_MS)
              context.set({ ...context.get(), validFor: e.payload.validFor });
            return {};
          },
        });
        /** Starts saving a new link's end time for `payload`'s album, with the time picked. */
        const startSaving = (
          payload: { folderId: string; code: string },
          context: { get(): InviteLinkContext; set(c: InviteLinkContext): void },
        ) => {
          const current = context.get();
          const expiresAt = endFor(clock.now(), current.validFor, current.lastExpiresAt);
          context.set({
            ...current,
            folderId: payload.folderId,
            lastExpiresAt: expiresAt,
            offFolderId: current.offFolderId === payload.folderId ? "" : current.offFolderId,
            ...(current.replacedFolderId === payload.folderId
              ? { replacedFolderId: "", removedName: "" }
              : {}),
          });
          return {
            state: savingLinkTime.create({
              expiresAt,
              code: payload.code,
              validFor: current.validFor,
            }),
          };
        };
        /** The owner makes a link that works for the chosen time. */
        m.on(noLinkYet, {
          event: createLink,
          to: [savingLinkTime],
          handler: (e, { context }) => {
            // The code was just turned off; wait for the album's new one.
            if (e.payload.folderId === "" || e.payload.code === context.get().offCode) return {};
            return startSaving(e.payload, context);
          },
        });
        /** A link for another album, or for this album's new code, replaces the one made; the same link is kept. */
        m.on(linkMade, {
          event: createLink,
          to: [savingLinkTime],
          handler: (e, { context, state }) => {
            if (
              e.payload.folderId === "" ||
              e.payload.code === context.get().offCode ||
              (e.payload.folderId === context.get().folderId &&
                e.payload.code === state.payload.code)
            )
              return {};
            return startSaving(e.payload, context);
          },
        });
        /** The owner makes one more link; the others keep working. */
        m.on(noLinkYet, {
          event: makeNewLink,
          to: [savingLinkTime],
          handler: (e, { context }) => {
            if (e.payload.folderId === "" || e.payload.code === context.get().offCode) return {};
            return startSaving(e.payload, context);
          },
        });
        /** The owner makes another link while one is shown. */
        m.on(linkMade, {
          event: makeNewLink,
          to: [savingLinkTime],
          handler: (e, { context }) => {
            if (e.payload.folderId === "" || e.payload.code === context.get().offCode) return {};
            return startSaving(e.payload, context);
          },
        });
        /** The owner ends one link. */
        m.on(noLinkYet, {
          event: endLink,
          to: [endingLink],
          handler: (e) => {
            if (e.payload.folderId === "") return {};
            return { state: endingLink.create(e.payload) };
          },
        });
        /** The owner ends a link while one is shown. */
        m.on(linkMade, {
          event: endLink,
          to: [endingLink],
          handler: (e, { state }) => {
            if (e.payload.folderId === "") return {};
            const { expiresAt, code } = state.payload as { expiresAt: number; code: string };
            return { state: endingLink.create({ ...e.payload, before: { expiresAt, code } }) };
          },
        });
        /** The link is ended on this phone. */
        m.effect(endingLink, {
          name: "endLink",
          sends: [oneLinkEnded, couldNotEndLink],
          fn: ({ signal, emit, state }) => {
            const { folderId, endsAt } = state.payload;
            return runInvoke(
              signal,
              () => port.endLink(folderId, endsAt),
              () => emit(oneLinkEnded.create()),
              () => emit(couldNotEndLink.create()),
            );
          },
        });
        /** Ended: the shown link stays unless it was the one ended. */
        m.on(endingLink, {
          event: oneLinkEnded,
          to: [noLinkYet, linkMade],
          handler: (_e, { state }) => {
            const { folderId, endsAt, before } = state.payload as {
              folderId: string;
              endsAt: number;
              before?: { expiresAt: number; code: string };
            };
            const keep = before !== undefined && before.expiresAt !== endsAt;
            return {
              state: keep ? linkMade.create(before) : noLinkYet,
              emit: [linkEnded.create({ folderId, endsAt })],
            };
          },
        });
        /** Failed: the panel goes back to what it showed. */
        m.on(endingLink, {
          event: couldNotEndLink,
          to: [noLinkYet, linkMade],
          handler: (_e, { state }) => {
            const { folderId, before } = state.payload as {
              folderId: string;
              before?: { expiresAt: number; code: string };
            };
            return {
              state: before ? linkMade.create(before) : noLinkYet,
              emit: [endLinkFailed.create({ folderId })],
            };
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
        /** Saved: the link can be handed out, unless a later pick still needs its own end time saved first. */
        m.on(savingLinkTime, {
          event: linkTimeSaved,
          to: [linkMade, savingLinkTime],
          handler: (_e, { context, state }) => {
            const saving = state.payload;
            const { validFor } = context.get();
            if (validFor !== saving.validFor) {
              const expiresAt = endFor(clock.now(), validFor, context.get().lastExpiresAt);
              context.set({ ...context.get(), lastExpiresAt: expiresAt });
              return { state: savingLinkTime.create({ expiresAt, code: saving.code, validFor }) };
            }
            return { state: linkMade.create({ expiresAt: saving.expiresAt, code: saving.code }) };
          },
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
        /** The owner turns off the links while a link's time saves; no link is handed out. */
        m.on(savingLinkTime, {
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
            const { expiresAt, code } = state.payload as { expiresAt: number; code: string };
            return { state: turningOff.create({ ...e.payload, before: { expiresAt, code } }) };
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
            const { before } = state.payload as { before?: { expiresAt: number; code: string } };
            const keep = before !== undefined && e.payload.folderId !== current.folderId;
            context.set({
              ...current,
              offCode: e.payload.code,
              offFolderId: e.payload.folderId,
              validFor: keep ? current.validFor : "1d",
              ...(current.replacedFolderId === e.payload.folderId
                ? { replacedFolderId: "", removedName: "" }
                : {}),
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
            const { before } = state.payload as { before?: { expiresAt: number; code: string } };
            return {
              state: before ? linkMade.create(before) : noLinkYet,
              emit: [turnOffFailed.create({ folderId: e.payload.folderId })],
            };
          },
        });
        /** A removal before any link is shown: the old code is refused; a second removal names the new person. */
        m.on(noLinkYet, {
          event: linkReplaced,
          handler: (e, { context }) => {
            if (e.payload.folderId === "" || e.payload.code === "") return {};
            const current = context.get();
            context.set({
              ...current,
              offCode: e.payload.code,
              ...(current.replacedFolderId === e.payload.folderId
                ? { removedName: e.payload.name }
                : {}),
            });
            return {};
          },
        });
        /** A removal while a link is shown: another album's link stays; this album's goes back to the picker. */
        m.on(linkMade, {
          event: linkReplaced,
          to: [noLinkYet, linkMade],
          handler: (e, { context }) => {
            if (e.payload.folderId === "" || e.payload.code === "") return {};
            const current = context.get();
            if (e.payload.folderId !== current.folderId) {
              context.set({ ...current, offCode: e.payload.code });
              return {};
            }
            context.set({
              ...current,
              offCode: e.payload.code,
              replacedFolderId: e.payload.folderId,
              removedName: e.payload.name,
              validFor: "1d",
            });
            return { state: noLinkYet };
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
  },
});

/** A link can always run out. */
export const inviteLinkExpectations: Expectations<typeof inviteLinkMachine> = {
  machine: "inviteLink",
  states: {
    linkMade: { mustSee: [{}] },
  },
};
