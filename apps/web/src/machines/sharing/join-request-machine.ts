import { Actor, event, state } from "@mantaq/core";
import type { Clock } from "@mantaq/core";
import { runInvoke } from "../actor-utils";
import { parseInviteLink } from "../../utils/invite-link";
import type { JoinInvite } from "../../utils/invite-link";

/**
 * The joiner's screens, from opening an invite link to the Admin's answer.
 * The link carries no album key; the key arrives only if the Admin accepts.
 */

/** What the app already knows about a link's invite code. */
export type Known =
  | { kind: "new" }
  | { kind: "own"; folderId: string }
  | { kind: "member"; folderId: string }
  | { kind: "waiting" }
  | { kind: "declined" };

/** A request this phone already made, as the albums list shows it. */
export type AskSummary = {
  code: string;
  owner: string;
  albumName: string;
  ownerName: string;
  askedAt: number;
  status: "waiting" | "declined";
};

/** Sends the request; resolves `[error, result]` like the gateway. */
export type JoinPort = { ask(invite: JoinInvite): Promise<[unknown, unknown]> };

export const GARBLED_LINK = "That invite doesn't look right. Check you copied all of it.";
export const oldLinkMessage = (ownerName: string) =>
  `This link no longer works. Ask ${ownerName} for a new invite link.`;
export const EXPIRED_LINK = "This invite link has expired.";
export const expiredBody = (owner: string) => `Ask ${owner} for a new one.`;
export const SEND_FAILED = "Couldn't send your request. Try again.";

/** No invite is open. */
const noInviteOpen = state("noInviteOpen")();
/** The opened text is not a link that works; the reason shows under the paste box. */
const showingLinkProblem = state("showingLinkProblem")();
/** "Ask to join <album>?" is on screen. No photos, no counts. */
const decidingToAsk = state("decidingToAsk")<JoinInvite>();
/** The request is being sent; the buttons are disabled. */
const sendingRequest = state("sendingRequest")<JoinInvite>();
/** "Waiting for <owner>". Shown with no timer until an answer comes. */
const waitingForAdminToAccept = state("waitingForAdminToAccept")<JoinInvite>();
/** "<owner> didn't accept your request." The answer is final. */
const declinedByAdmin = state("declinedByAdmin")<JoinInvite>();
/** The link's end time has passed; nothing is sent. */
const linkExpired = state("linkExpired")<JoinInvite>();
/** The joiner is in the album, accepted just now or already in, and the app opens it. Not final: this screen machine takes the next link. */
const joinedAlbum = state("joinedAlbum")();

/** The joiner opens a link or pastes text. */
export const openLink = event("openLink")<{ text: string }>();
/** The joiner taps a request row in the albums list. */
export const reopenRequest = event("reopenRequest")<{ ask: AskSummary }>();
/** The joiner taps "Ask to join". */
export const askToJoin = event("askToJoin")();
/** The joiner taps "Not now". */
export const notNow = event("notNow")();
/** The joiner closes the waiting screen; the request stays. */
export const closeWaiting = event("closeWaiting")();
/** The joiner taps OK on the declined screen. */
export const dismissDecline = event("dismissDecline")();
/** The joiner taps OK on the expired screen. */
export const dismissExpired = event("dismissExpired")();
/** The owner's answer reached this phone. */
export const requestAnswered = event("requestAnswered")<{
  code: string;
  answer: "accepted" | "declined";
  folderId?: string;
}>();

/** The request was sent. */
const requestSent = event("requestSent")();
/** The request could not be sent. */
const requestFailed = event("requestFailed")<{ message: string }>();

/** Asks the app to show the album: the joiner is already in, or was just accepted. */
const openAlbum = event("openAlbum")<{ folderId: string }>();

type JoinContext = { error: string };

const allowAll: JoinPort = { ask: async () => [undefined, {}] };

export function createJoinRequestActor(options: {
  clock: Clock;
  port?: JoinPort;
  known?: Known | ((invite: JoinInvite) => Known);
}) {
  const { clock, port = allowAll, known = { kind: "new" } } = options;
  const classify = typeof known === "function" ? known : () => known;

  return Actor({
    inputs: [
      openLink,
      reopenRequest,
      askToJoin,
      notNow,
      closeWaiting,
      dismissDecline,
      dismissExpired,
      requestAnswered,
    ],
    internal: [requestSent, requestFailed],
    outputs: [openAlbum],
    states: [
      noInviteOpen,
      showingLinkProblem,
      joinedAlbum,
      decidingToAsk,
      sendingRequest,
      waitingForAdminToAccept,
      declinedByAdmin,
      linkExpired,
    ],
    initial: noInviteOpen,
    clock,
    context: { error: "" } as JoinContext,
    setup: (m) => {
      for (const from of [
        noInviteOpen,
        showingLinkProblem,
        joinedAlbum,
        decidingToAsk,
        waitingForAdminToAccept,
        declinedByAdmin,
        linkExpired,
      ]) {
        /** A link opens the screen that fits what this phone knows about it. */
        m.on(from, {
          event: openLink,
          to: [showingLinkProblem, joinedAlbum, decidingToAsk, waitingForAdminToAccept, declinedByAdmin, linkExpired],
          handler: (e, { actor, context }) => {
            const parsed = parseInviteLink(e.payload.text);
            if (parsed.kind !== "invite") {
              context.set({
                error: parsed.kind === "old" ? oldLinkMessage(parsed.ownerName) : GARBLED_LINK,
              });
              return { state: unusableOrStay(actor) };
            }
            context.set({ error: "" });
            const invite = parsed.invite;
            const found = classify(invite);
            if (found.kind === "own" || found.kind === "member") {
              return { state: joinedAlbum, emit: [openAlbum.create({ folderId: found.folderId })] };
            }
            if (found.kind === "waiting") return { state: waitingForAdminToAccept.create(invite) };
            if (found.kind === "declined") return { state: declinedByAdmin.create(invite) };
            if (invite.expiresAt !== undefined && clock.now() >= invite.expiresAt) {
              return { state: linkExpired.create(invite) };
            }
            return { state: decidingToAsk.create(invite) };
          },
        });
        /** A tapped request row shows its current answer. */
        m.on(from, {
          event: reopenRequest,
          to: [waitingForAdminToAccept, declinedByAdmin],
          handler: (e) => {
            const { ask: row } = e.payload;
            const invite = {
              code: row.code,
              owner: row.owner,
              album: row.albumName,
              ownerName: row.ownerName,
            };
            return row.status === "declined"
              ? { state: declinedByAdmin.create(invite) }
              : { state: waitingForAdminToAccept.create(invite) };
          },
        });
      }

      /** "Ask to join": the request goes out and the buttons lock. */
      m.on(decidingToAsk, {
        event: askToJoin,
        to: [sendingRequest],
        handler: (_e, { actor, context }) => {
          context.set({ error: "" });
          return { state: sendingRequest.create(actor.snapshot().payload as JoinInvite) };
        },
      });
      /** "Not now": nothing was sent. */
      m.on(decidingToAsk, {
        event: notNow,
        to: [noInviteOpen],
        handler: () => ({ state: noInviteOpen }),
      });

      /** The request is handed to the phone's sharing layer. */
      m.effect(sendingRequest, {
        name: "sendRequest",
        sends: [requestSent, requestFailed],
        fn: ({ signal, emit, state: current }) =>
          runInvoke(
            signal,
            () => port.ask(current.payload as JoinInvite),
            () => emit(requestSent.create()),
            () => emit(requestFailed.create({ message: SEND_FAILED })),
          ),
      });
      /** The request is on its way: "Waiting for <Admin>". */
      m.on(sendingRequest, {
        event: requestSent,
        to: [waitingForAdminToAccept],
        handler: (_e, { actor }) => ({
          state: waitingForAdminToAccept.create(actor.snapshot().payload as JoinInvite),
        }),
      });
      /** The send failed: back to the question, with the error shown. */
      m.on(sendingRequest, {
        event: requestFailed,
        to: [decidingToAsk],
        handler: (e, { actor, context }) => {
          context.set({ error: e.payload.message });
          return { state: decidingToAsk.create(actor.snapshot().payload as JoinInvite) };
        },
      });

      /** The joiner closes the screen; the request stays pending. */
      m.on(waitingForAdminToAccept, {
        event: closeWaiting,
        to: [noInviteOpen],
        handler: () => ({ state: noInviteOpen }),
      });
      /** The Admin answered. Only an answer for this request counts. */
      m.on(waitingForAdminToAccept, {
        event: requestAnswered,
        to: [joinedAlbum, declinedByAdmin, waitingForAdminToAccept],
        handler: (e, { actor }) => {
          const invite = actor.snapshot().payload as JoinInvite;
          if (e.payload.code !== invite.code)
            return { state: waitingForAdminToAccept.create(invite) };
          if (e.payload.answer === "declined") return { state: declinedByAdmin.create(invite) };
          const folderId = e.payload.folderId;
          return folderId === undefined
            ? { state: waitingForAdminToAccept.create(invite) }
            : { state: joinedAlbum, emit: [openAlbum.create({ folderId })] };
        },
      });

      /** The joiner closes the expired screen. */
      m.on(linkExpired, {
        event: dismissExpired,
        to: [noInviteOpen],
        handler: () => ({ state: noInviteOpen }),
      });

      /** The joiner acknowledges the answer. */
      m.on(declinedByAdmin, {
        event: dismissDecline,
        to: [noInviteOpen],
        handler: () => ({ state: noInviteOpen }),
      });
    },
  });
}

/** From a screen with no invite, an unusable link shows its error; from an invite screen, the screen stays. */
function unusableOrStay(actor: { snapshot(): { path: string[]; payload?: unknown } }) {
  const snap = actor.snapshot();
  const invite = snap.payload as JoinInvite;
  switch (snap.path[0]) {
    case "decidingToAsk":
      return decidingToAsk.create(invite);
    case "waitingForAdminToAccept":
      return waitingForAdminToAccept.create(invite);
    case "declinedByAdmin":
      return declinedByAdmin.create(invite);
    case "linkExpired":
      return linkExpired.create(invite);
    default:
      return showingLinkProblem;
  }
}
