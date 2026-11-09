import { Actor, event, state } from "@mantaq/core";
import type { Clock } from "@mantaq/core";
import { runInvoke } from "../actor-utils";
import { parseInviteLink } from "../../utils/invite-link";
import type { JoinInvite } from "../../utils/invite-link";

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
  /** An earlier request through this code was told the link no longer works. */
  | { kind: "turnedOff" };

/** A request this phone already made, as the albums list shows it. */
export type AskSummary = {
  code: string;
  owner: string;
  albumName: string;
  ownerName: string;
  askedAt: number;
  status: "waiting" | "declined" | "linkOff";
  whoMustUpdate?: "you";
};

/** Sends the request; resolves `[error, result]` like the gateway. */
export type JoinPort = { ask(invite: JoinInvite): Promise<[unknown, unknown]> };

export const GARBLED_LINK = copy("join_request.that_invite_doesn_t_look");
export const oldLinkMessage = (ownerName: string) =>
  copy("join_request.this_link_no_longer_works", { ownerName });
export const EXPIRED_LINK = copy("join_request.this_invite_link_has_expired");
export const expiredBody = (owner: string) => copy("join_request.ask_for_a_new_one", { owner });
export const LINK_TURNED_OFF = copy("join_request.this_invite_link_no_longer");
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
/** The Admin's phone said this link no longer works, so the request will not be answered. "Ask <owner> for a new one." */
const linkTurnedOff = state("linkTurnedOff")<JoinInvite>();
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
/** The joiner closes the "no longer works" screen; the row stays until Cancel request or a new link. */
export const closeLinkTurnedOff = event("closeLinkTurnedOff")();
/** This phone compared Justus versions with the Admin of a waiting request. */
export const whoMustUpdateChanged = event("whoMustUpdateChanged")<{
  code: string;
  who: "you" | "nobody";
}>();
/** The owner's answer reached this phone. */
export const requestAnswered = event("requestAnswered")<{
  code: string;
  answer: "accepted" | "declined" | "linkOff";
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
    if (found.kind === "turnedOff") return { state: linkTurnedOff.create(invite) };
    if (hasEnded(invite, clock.now())) return { state: linkExpired.create(invite) };
    return { state: decidingToAsk.create(invite) };
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
      closeLinkTurnedOff,
      requestAnswered,
      whoMustUpdateChanged,
    ],
    internal: [requestSent, requestFailed],
    outputs: [openAlbum, dismissDeclinedAsk, cancelAsk],
    states: [
      noInviteOpen,
      showingWelcome,
      holdingInviteUntilWelcomeEnds,
      showingLinkProblem,
      joinedAlbum,
      decidingToAsk,
      sendingRequest,
      waitingForAdminToAccept,
      waitingForYouToUpdate,
      declinedByAdmin,
      linkExpired,
      linkTurnedOff,
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
        waitingForYouToUpdate,
        declinedByAdmin,
        linkExpired,
        linkTurnedOff,
      ]) {
        /** A link opens the screen that fits what this phone knows about it. */
        m.on(from, {
          event: openLink,
          to: [
            showingLinkProblem,
            joinedAlbum,
            decidingToAsk,
            waitingForAdminToAccept,
            waitingForYouToUpdate,
            declinedByAdmin,
            linkExpired,
            linkTurnedOff,
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
          to: [waitingForAdminToAccept, waitingForYouToUpdate, declinedByAdmin, linkTurnedOff],
          handler: (e) => {
            const { ask: row } = e.payload;
            const invite = inviteOf(row);
            if (row.status === "linkOff") return { state: linkTurnedOff.create(invite) };
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
          linkTurnedOff,
          decidingToAsk,
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
          to: [joinedAlbum, declinedByAdmin, linkTurnedOff, from],
          handler: (e) => {
            if (e.payload.answer === "linkOff") {
              const row = asked(e.payload.code);
              return row === undefined
                ? { state: from }
                : { state: linkTurnedOff.create(inviteOf(row)) };
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

      for (const from of [decidingToAsk, sendingRequest, linkExpired, linkTurnedOff]) {
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
          to: [joinedAlbum, declinedByAdmin, linkTurnedOff, from],
          handler: (e, { actor }) => {
            const invite = actor.snapshot().payload as JoinInvite;
            if (e.payload.code !== invite.code) return { state: from.create(invite) };
            if (e.payload.answer === "declined") return { state: declinedByAdmin.create(invite) };
            if (e.payload.answer === "linkOff") return { state: linkTurnedOff.create(invite) };
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

      /** The joiner takes the request back from the "no longer works" screen. */
      m.on(linkTurnedOff, {
        event: cancelRequest,
        to: [noInviteOpen],
        handler: (_e, { actor }) => {
          const invite = actor.snapshot().payload as JoinInvite;
          sent.delete(invite.code);
          return { state: noInviteOpen, emit: [cancelAsk.create({ code: invite.code })] };
        },
      });
      /** The joiner closes the screen; the request row stays. */
      m.on(linkTurnedOff, {
        event: closeLinkTurnedOff,
        to: [noInviteOpen],
        handler: () => ({ state: noInviteOpen }),
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
    case "waitingForYouToUpdate":
      return waitingForYouToUpdate.create(invite);
    case "declinedByAdmin":
      return declinedByAdmin.create(invite);
    case "linkExpired":
      return linkExpired.create(invite);
    case "linkTurnedOff":
      return linkTurnedOff.create(invite);
    default:
      return showingLinkProblem;
  }
}
