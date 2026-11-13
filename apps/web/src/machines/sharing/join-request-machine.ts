import { Actor, event, state } from "@mantaq/core";
import type { Clock } from "@mantaq/core";
import { runInvoke } from "../actor-utils";
import { ownerShown, parseInviteLink } from "../../utils/invite-link";
import type { JoinInvite } from "../../utils/invite-link";
import type { LinkOffWhy } from "@justus/core";

import { copy } from "../../copy/copy";
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
  /** An earlier request through this code was told the link no longer works; `why` is the reason when the Admin's phone gave one. */
  | { kind: "stopped"; why?: LinkOffWhy };

/** A request this phone already made, as the albums list shows it. */
export type AskSummary = {
  code: string;
  owner: string;
  albumName: string;
  ownerName: string;
  askedAt: number;
  status: "waiting" | "declined" | "linkOff";
  why?: LinkOffWhy;
  whoMustUpdate?: "you";
};

/** Sends the request; resolves `[error, result]` like the gateway. */
export type JoinPort = {
  ask(invite: JoinInvite): Promise<[unknown, unknown]>;
  /** Reads whether the owner turned this link off; `[error, { turnedOff }]`. */
  checkLink?(invite: JoinInvite): Promise<[unknown, unknown]>;
};

export const GARBLED_LINK = copy("join_request.that_invite_doesn_t_look");
export const oldLinkMessage = (ownerName: string) =>
  copy("join_request.this_link_no_longer_works", { ownerName: ownerShown(ownerName, "mid") });
export const EXPIRED_LINK = copy("join_request.this_invite_link_has_expired");
export const expiredBody = (owner: string) =>
  copy("join_request.ask_for_a_new_one", { owner: ownerShown(owner, "mid") });
export const NOTHING_COPIED = copy("join_request.nothing_copied_yet");
export const SEND_FAILED = copy("join_request.couldn_t_send_your_request");

/** No invite is open. */
const noInviteOpen = state("noInviteOpen")();
/** The first-run welcome is on screen and no invite link is waiting. */
const showingWelcome = state("showingWelcome")();
/** An invite link arrived during the welcome. No sheet shows; the question opens when the name is saved. */
const holdingInviteUntilWelcomeEnds = state("holdingInviteUntilWelcomeEnds")<JoinInvite>();
/** The opened text is not a link that works; the reason shows under the paste box. */
const showingLinkProblem = state("showingLinkProblem")();
/** "Checking <owner>'s link…": the owner's phone is asked whether the link was turned off, for at most a few seconds. Nothing is sent. */
const checkingLink = state("checkingLink")<JoinInvite>();
/** "Ask to join <album>?" is on screen. No photos, no counts. */
const decidingToAsk = state("decidingToAsk")<JoinInvite>();
/** The request is being sent; the buttons are disabled. */
const sendingRequest = state("sendingRequest")<JoinInvite>();
/** "Waiting for <owner>". Shown with no timer until an answer comes. */
const waitingForAdminToAccept = state("waitingForAdminToAccept")<JoinInvite>();
/** This phone's Justus is older than the Admin's: "Update Justus to join". The request stays and goes out once both match. */
const waitingForYouToUpdate = state("waitingForYouToUpdate")<JoinInvite>();
/** "<owner> didn't accept your request." OK takes the request off this phone; the link can be asked through again. */
const declinedByAdmin = state("declinedByAdmin")<JoinInvite>();
/** The link's end time has passed; nothing is sent. */
const linkExpired = state("linkExpired")<JoinInvite>();
/** "<owner> turned off this link." The request was not answered; "Ask <owner> for a new link if you still want to join." */
const linkTurnedOffByAdmin = state("linkTurnedOffByAdmin")<JoinInvite>();
/** "<owner> replaced this link." The request was not answered; "Ask <owner> for the new link." */
const linkReplacedByAdmin = state("linkReplacedByAdmin")<JoinInvite>();
/** "<owner> deleted this album." "There is nothing to join any more." */
const albumDeletedByAdmin = state("albumDeletedByAdmin")<JoinInvite>();
/** "This invite link no longer works. Ask <owner> for a new one." The Admin's phone gave no reason (an older Justus, or a link turned off before reasons were kept). */
const linkStoppedForUnknownReason = state("linkStoppedForUnknownReason")<JoinInvite>();
const stoppedStates = [
  linkTurnedOffByAdmin,
  linkReplacedByAdmin,
  albumDeletedByAdmin,
  linkStoppedForUnknownReason,
] as const;
/** The joiner is in the album, accepted just now or already in, and the app opens it. Not final: this screen machine takes the next link. */
const joinedAlbum = state("joinedAlbum")();

/** The first-run welcome opened on this phone. */
export const welcomeStarted = event("welcomeStarted")();
/** The person finished the welcome: their name is saved. */
export const welcomeEnded = event("welcomeEnded")();
/** The joiner tapped Paste with nothing copied. */
export const pasteFoundNothing = event("pasteFoundNothing")();
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
/** The joiner closes a stopped-link screen; a dead request leaves Waiting to join. */
export const closeStoppedLink = event("closeStoppedLink")();
/** This phone compared Justus versions with the Admin of a waiting request. */
export const whoMustUpdateChanged = event("whoMustUpdateChanged")<{
  code: string;
  who: "you" | "nobody";
}>();
/** The owner's answer, as the push carries it. */
export type RequestAnswer =
  | { code: string; answer: "accepted"; folderId?: string }
  | { code: string; answer: "declined" }
  | { code: string; answer: "linkOff"; why?: LinkOffWhy };
/** The owner's answer reached this phone. */
export const requestAnswered = event("requestAnswered")<RequestAnswer>();

/** The owner's phone answered whether the link is turned off; any failure reads as not off. */
const linkChecked = event("linkChecked")<{ turnedOff: boolean }>();
/** The request was sent. */
const requestSent = event("requestSent")();
/** The request could not be sent. */
const requestFailed = event("requestFailed")<{ message: string }>();

/** Asks the app to show the album: the joiner is already in, or was just accepted. */
const openAlbum = event("openAlbum")<{ folderId: string }>();
/** Asks the app to take the declined request off this phone. */
export const dismissDeclinedAsk = event("dismissDeclinedAsk")<{ code: string }>();
/** Asks the app to take the request off this phone: a waiting one stops reaching the Admin; a dead one leaves Waiting to join. */
export const cancelAsk = event("cancelAsk")<{ code: string }>();

/** The screen that says why a link stopped working. */
function stoppedScreen(why: LinkOffWhy | undefined, invite: JoinInvite) {
  switch (why) {
    case "expired":
      return linkExpired.create(invite);
    case "turnedOff":
      return linkTurnedOffByAdmin.create(invite);
    case "replaced":
      return linkReplacedByAdmin.create(invite);
    case "albumDeleted":
      return albumDeletedByAdmin.create(invite);
    default:
      return linkStoppedForUnknownReason.create(invite);
  }
}

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
    checkLink: async () => [undefined, { turnedOff: false }],
  };
  const asked = options.asked ?? ((code: string) => sent.get(code));
  const classify = typeof known === "function" ? known : () => known;

  /** The waiting screen that fits who must update. */
  function waitingFor(who: "you" | "nobody" | undefined) {
    return who === "you" ? waitingForYouToUpdate : waitingForAdminToAccept;
  }

  /** The screen a usable link opens, from what this phone knows about it. */
  function screenFor(invite: JoinInvite) {
    const found = classify(invite);
    if (found.kind === "own" || found.kind === "member") {
      return { state: joinedAlbum, emit: [openAlbum.create({ folderId: found.folderId })] };
    }
    if (found.kind === "waiting") {
      return { state: waitingFor(asked(invite.code)?.whoMustUpdate).create(invite) };
    }
    if (found.kind === "stopped") return { state: stoppedScreen(found.why, invite) };
    if (hasEnded(invite, clock.now())) return { state: linkExpired.create(invite) };
    return { state: checkingLink.create(invite) };
  }

  return Actor({
    inputs: [
      welcomeStarted,
      welcomeEnded,
      pasteFoundNothing,
      openLink,
      reopenRequest,
      askToJoin,
      notNow,
      closeWaiting,
      cancelRequest,
      dismissDecline,
      dismissExpired,
      closeStoppedLink,
      requestAnswered,
      whoMustUpdateChanged,
    ],
    internal: [requestSent, requestFailed, linkChecked],
    outputs: [openAlbum, dismissDeclinedAsk, cancelAsk],
    states: [
      noInviteOpen,
      showingWelcome,
      holdingInviteUntilWelcomeEnds,
      showingLinkProblem,
      joinedAlbum,
      checkingLink,
      decidingToAsk,
      sendingRequest,
      waitingForAdminToAccept,
      waitingForYouToUpdate,
      declinedByAdmin,
      linkExpired,
      ...stoppedStates,
    ],
    initial: noInviteOpen,
    clock,
    context: { error: "" } as JoinContext,
    setup: (m) => {
      for (const from of [
        noInviteOpen,
        showingLinkProblem,
        joinedAlbum,
        checkingLink,
        decidingToAsk,
        waitingForAdminToAccept,
        waitingForYouToUpdate,
        declinedByAdmin,
        linkExpired,
        ...stoppedStates,
      ]) {
        /** A link opens the screen that fits what this phone knows about it. */
        m.on(from, {
          event: openLink,
          to: [
            showingLinkProblem,
            joinedAlbum,
            checkingLink,
            decidingToAsk,
            waitingForAdminToAccept,
            waitingForYouToUpdate,
            declinedByAdmin,
            linkExpired,
            ...stoppedStates,
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
            return screenFor(parsed.invite);
          },
        });
        /** A tapped request row shows its current answer. */
        m.on(from, {
          event: reopenRequest,
          to: [
            waitingForAdminToAccept,
            waitingForYouToUpdate,
            declinedByAdmin,
            linkExpired,
            ...stoppedStates,
          ],
          handler: (e) => {
            const { ask: row } = e.payload;
            const invite = inviteOf(row);
            if (row.status === "linkOff") return { state: stoppedScreen(row.why, invite) };
            return row.status === "declined"
              ? { state: declinedByAdmin.create(invite) }
              : { state: waitingFor(row.whoMustUpdate).create(invite) };
          },
        });
      }

      /** The first-run welcome opens. */
      m.on(noInviteOpen, {
        event: welcomeStarted,
        to: [showingWelcome],
        handler: (_e, { context }) => {
          context.set({ error: "" });
          return { state: showingWelcome };
        },
      });
      /** A usable link during the welcome waits; an unusable one is dropped. */
      m.on(showingWelcome, {
        event: openLink,
        to: [holdingInviteUntilWelcomeEnds, showingWelcome],
        handler: (e) => {
          const parsed = parseInviteLink(e.payload.text);
          return parsed.kind === "invite"
            ? { state: holdingInviteUntilWelcomeEnds.create(parsed.invite) }
            : { state: showingWelcome };
        },
      });
      /** A newer link replaces the held one; an unusable one leaves it. */
      m.on(holdingInviteUntilWelcomeEnds, {
        event: openLink,
        to: [holdingInviteUntilWelcomeEnds],
        handler: (e, { actor }) => {
          const parsed = parseInviteLink(e.payload.text);
          return {
            state: holdingInviteUntilWelcomeEnds.create(
              parsed.kind === "invite" ? parsed.invite : (actor.snapshot().payload as JoinInvite),
            ),
          };
        },
      });
      /** The name is saved with no link waiting: nothing opens. */
      m.on(showingWelcome, {
        event: welcomeEnded,
        to: [noInviteOpen],
        handler: () => ({ state: noInviteOpen }),
      });
      /** The name is saved: the held link opens the screen that fits it now. */
      m.on(holdingInviteUntilWelcomeEnds, {
        event: welcomeEnded,
        to: [
          joinedAlbum,
          waitingForAdminToAccept,
          waitingForYouToUpdate,
          linkExpired,
          ...stoppedStates,
          checkingLink,
        ],
        handler: (_e, { actor }) => screenFor(actor.snapshot().payload as JoinInvite),
      });
      for (const from of [noInviteOpen, showingLinkProblem]) {
        /** Paste with nothing copied says so under the box. */
        m.on(from, {
          event: pasteFoundNothing,
          to: [showingLinkProblem],
          handler: (_e, { context }) => {
            context.set({ error: NOTHING_COPIED });
            return { state: showingLinkProblem };
          },
        });
      }

      for (const from of [noInviteOpen, showingLinkProblem, joinedAlbum]) {
        /** An answer that arrives with no sheet open still counts: accepted opens the album, declined says so. */
        m.on(from, {
          event: requestAnswered,
          to: [joinedAlbum, declinedByAdmin, linkExpired, ...stoppedStates, from],
          handler: (e) => {
            if (e.payload.answer === "linkOff") {
              const row = asked(e.payload.code);
              return row === undefined
                ? { state: from }
                : { state: stoppedScreen(e.payload.why, inviteOf(row)) };
            }
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

      for (const from of [
        checkingLink,
        decidingToAsk,
        sendingRequest,
        linkExpired,
        ...stoppedStates,
      ]) {
        /** An accept for an earlier request still opens the album over another sheet. A decline leaves the open sheet alone; the request row shows it. The open declined sheet takes no answer. */
        m.on(from, {
          event: requestAnswered,
          to: [joinedAlbum, from],
          handler: (e, { actor }) => {
            const answer = e.payload;
            return answer.answer === "accepted" && answer.folderId !== undefined
              ? { state: joinedAlbum, emit: [openAlbum.create({ folderId: answer.folderId })] }
              : { state: from.create(actor.snapshot().payload as JoinInvite) };
          },
        });
      }

      /** The owner's phone is asked whether the link is off. Nothing is sent, and no failure is shown: not knowing leads to the question. */
      m.effect(checkingLink, {
        name: "checkLink",
        sends: [linkChecked],
        fn: ({ signal, emit, state: current }) =>
          runInvoke(
            signal,
            () =>
              port.checkLink?.(current.payload as JoinInvite) ??
              Promise.resolve([undefined, { turnedOff: false }] as [unknown, unknown]),
            (r) =>
              emit(
                linkChecked.create({
                  turnedOff: (r as { turnedOff?: unknown } | undefined)?.turnedOff === true,
                }),
              ),
            () => emit(linkChecked.create({ turnedOff: false })),
          ),
      });
      /** Off: the link is refused before any question. Anything else: today's question. */
      m.on(checkingLink, {
        event: linkChecked,
        to: [linkTurnedOffByAdmin, decidingToAsk],
        handler: (e, { actor }) => {
          const invite = actor.snapshot().payload as JoinInvite;
          return e.payload.turnedOff
            ? { state: linkTurnedOffByAdmin.create(invite) }
            : { state: decidingToAsk.create(invite) };
        },
      });

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
        to: [waitingForAdminToAccept, waitingForYouToUpdate],
        handler: (_e, { actor }) => {
          const invite = actor.snapshot().payload as JoinInvite;
          return { state: waitingFor(asked(invite.code)?.whoMustUpdate).create(invite) };
        },
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

      for (const from of [waitingForAdminToAccept, waitingForYouToUpdate]) {
        /** The joiner closes the screen; the request stays pending. */
        m.on(from, {
          event: closeWaiting,
          to: [noInviteOpen],
          handler: () => ({ state: noInviteOpen }),
        });
        /** The joiner takes the request back; the app removes it from this phone. */
        m.on(from, {
          event: cancelRequest,
          to: [noInviteOpen],
          handler: (_e, { actor }) => {
            const invite = actor.snapshot().payload as JoinInvite;
            sent.delete(invite.code);
            return { state: noInviteOpen, emit: [cancelAsk.create({ code: invite.code })] };
          },
        });
        /** The Admin answered. Only an answer for this request counts. */
        m.on(from, {
          event: requestAnswered,
          to: [joinedAlbum, declinedByAdmin, linkExpired, ...stoppedStates, from],
          handler: (e, { actor }) => {
            const invite = actor.snapshot().payload as JoinInvite;
            if (e.payload.code !== invite.code) return { state: from.create(invite) };
            if (e.payload.answer === "declined") return { state: declinedByAdmin.create(invite) };
            if (e.payload.answer === "linkOff") {
              return { state: stoppedScreen(e.payload.why, invite) };
            }
            const folderId = e.payload.folderId;
            return folderId === undefined
              ? { state: from.create(invite) }
              : { state: joinedAlbum, emit: [openAlbum.create({ folderId })] };
          },
        });
        /** The phones compared versions: the screen says who must update. Another request's mark changes nothing. */
        m.on(from, {
          event: whoMustUpdateChanged,
          to: [waitingForAdminToAccept, waitingForYouToUpdate],
          handler: (e, { actor }) => {
            const invite = actor.snapshot().payload as JoinInvite;
            return e.payload.code === invite.code
              ? { state: waitingFor(e.payload.who).create(invite) }
              : { state: from.create(invite) };
          },
        });
      }

      /** The joiner closes a stopped-link or expired screen; a dead request leaves Waiting to join. */
      for (const [from, close] of [
        ...stoppedStates.map((st) => [st, closeStoppedLink] as const),
        [linkExpired, dismissExpired] as const,
      ]) {
        m.on(from, {
          event: close,
          to: [noInviteOpen],
          handler: (_e, { actor }) => {
            const { code } = actor.snapshot().payload as JoinInvite;
            const row = asked(code);
            if (row === undefined || row.status === "declined") return { state: noInviteOpen };
            sent.delete(code);
            return { state: noInviteOpen, emit: [cancelAsk.create({ code })] };
          },
        });
      }

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
    case "checkingLink":
      return checkingLink.create(invite);
    case "decidingToAsk":
      return decidingToAsk.create(invite);
    case "waitingForAdminToAccept":
      return waitingForAdminToAccept.create(invite);
    case "waitingForYouToUpdate":
      return waitingForYouToUpdate.create(invite);
    case "declinedByAdmin":
      return declinedByAdmin.create(invite);
    case "linkExpired":
      return linkExpired.create(invite);
    case "linkTurnedOffByAdmin":
      return linkTurnedOffByAdmin.create(invite);
    case "linkReplacedByAdmin":
      return linkReplacedByAdmin.create(invite);
    case "albumDeletedByAdmin":
      return albumDeletedByAdmin.create(invite);
    case "linkStoppedForUnknownReason":
      return linkStoppedForUnknownReason.create(invite);
    default:
      return showingLinkProblem;
  }
}
