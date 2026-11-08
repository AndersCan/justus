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
  | { kind: "waiting" };

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
/** "<owner> didn't accept your request." OK takes the request off this phone; the link can be asked through again. */
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
/** The joiner taps "Cancel request" on the waiting screen. */
export const cancelRequest = event("cancelRequest")();
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
/** Asks the app to take the declined request off this phone. */
export const dismissDeclinedAsk = event("dismissDeclinedAsk")<{ code: string }>();
/** Asks the app to take the waiting request off this phone; the Admin stops seeing it. */
export const cancelAsk = event("cancelAsk")<{ code: string }>();

function hasEnded(invite: JoinInvite, now: number): boolean {
  return invite.expiresAt !== undefined && now >= invite.expiresAt;
}

type JoinContext = { error: string };

export function createJoinRequestActor(options: {
  clock: Clock;
  port?: JoinPort;
  known?: Known | ((invite: JoinInvite) => Known);
  /** The ask this phone stored for an invite code, so an answer that arrives after the sheet closed can name the album. */
  asked?: (code: string) => AskSummary | undefined;
}) {
  const { clock, known = { kind: "new" } } = options;
  // The default port remembers what it asked, so an answer after the sheet closed finds the ask, as the app's stored asks do.
  const sent = new Map<string, AskSummary>();
  const port: JoinPort = options.port ?? {
    ask: async (invite) => {
      sent.set(invite.code, askOf(invite, clock.now()));
      return [undefined, {}];
    },
  };
  const asked = options.asked ?? ((code: string) => sent.get(code));
  const classify = typeof known === "function" ? known : () => known;

  return Actor({
    inputs: [
      openLink,
      reopenRequest,
      askToJoin,
      notNow,
      closeWaiting,
      cancelRequest,
      dismissDecline,
      dismissExpired,
      requestAnswered,
    ],
    internal: [requestSent, requestFailed],
    outputs: [openAlbum, dismissDeclinedAsk, cancelAsk],
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
          to: [
            showingLinkProblem,
            joinedAlbum,
            decidingToAsk,
            waitingForAdminToAccept,
            declinedByAdmin,
            linkExpired,
          ],
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
            if (hasEnded(invite, clock.now())) {
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
            const invite = inviteOf(row);
            return row.status === "declined"
              ? { state: declinedByAdmin.create(invite) }
              : { state: waitingForAdminToAccept.create(invite) };
          },
        });
      }

      for (const from of [noInviteOpen, showingLinkProblem, joinedAlbum]) {
        /** An answer that arrives with no sheet open still counts: accepted opens the album, declined says so. */
        m.on(from, {
          event: requestAnswered,
          to: [joinedAlbum, declinedByAdmin, from],
          handler: (e) => {
            if (e.payload.answer === "declined") {
              const row = asked(e.payload.code);
              return row === undefined
                ? { state: from }
                : { state: declinedByAdmin.create(inviteOf(row)) };
            }
            const folderId = e.payload.folderId;
            return folderId === undefined
              ? { state: from }
              : { state: joinedAlbum, emit: [openAlbum.create({ folderId })] };
          },
        });
      }

      for (const from of [decidingToAsk, sendingRequest, linkExpired]) {
        /** An accept for an earlier request still opens the album over another sheet. A decline leaves the open sheet alone; the request row shows it. The open declined sheet takes no answer. */
        m.on(from, {
          event: requestAnswered,
          to: [joinedAlbum, from],
          handler: (e, { actor }) => {
            const folderId = e.payload.folderId;
            return e.payload.answer === "accepted" && folderId !== undefined
              ? { state: joinedAlbum, emit: [openAlbum.create({ folderId })] }
              : { state: from.create(actor.snapshot().payload as JoinInvite) };
          },
        });
      }

      /** "Ask to join": the request goes out and the buttons lock. */
      m.on(decidingToAsk, {
        event: askToJoin,
        to: [sendingRequest, linkExpired],
        handler: (_e, { actor, context }) => {
          context.set({ error: "" });
          const invite = actor.snapshot().payload as JoinInvite;
          // The link may have ended while the question was open.
          if (hasEnded(invite, clock.now())) return { state: linkExpired.create(invite) };
          return { state: sendingRequest.create(invite) };
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
      /** The joiner takes the request back; the app removes it from this phone. */
      m.on(waitingForAdminToAccept, {
        event: cancelRequest,
        to: [noInviteOpen],
        handler: (_e, { actor }) => {
          const invite = actor.snapshot().payload as JoinInvite;
          sent.delete(invite.code);
          return { state: noInviteOpen, emit: [cancelAsk.create({ code: invite.code })] };
        },
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
        handler: (_e, { actor }) => ({
          state: noInviteOpen,
          emit: [
            dismissDeclinedAsk.create({ code: (actor.snapshot().payload as JoinInvite).code }),
          ],
        }),
      });
    },
  });
}

function askOf(invite: JoinInvite, askedAt: number): AskSummary {
  return {
    code: invite.code,
    owner: invite.owner,
    albumName: invite.album,
    ownerName: invite.ownerName,
    askedAt,
    status: "waiting",
  };
}

function inviteOf(row: AskSummary): JoinInvite {
  return { code: row.code, owner: row.owner, album: row.albumName, ownerName: row.ownerName };
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
