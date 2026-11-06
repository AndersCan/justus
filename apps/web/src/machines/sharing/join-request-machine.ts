import { Actor, event, state } from "@mantaq/core";
import type { Clock } from "@mantaq/core";
import { runInvoke } from "../actor-utils";
import { parseInviteLink } from "../../utils/invite-link";
import type { JoinInvite } from "../../utils/invite-link";

/**
 * Proposed flow, not wired into the app yet: the joiner's screens, from
 * opening an invite link to the owner's answer. The link carries no album key;
 * the key arrives only if the owner accepts.
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
export const SEND_FAILED = "Couldn't send your request. Try again.";

/** No link is open. */
const idle = state("idle")();
/** "Ask to join <album>?" is on screen. No photos, no counts. */
const reviewing = state("reviewing")<JoinInvite>();
/** The request is being sent; the buttons are disabled. */
const sending = state("sending")<JoinInvite>();
/** "Waiting for <owner>". Shown with no timer until an answer comes. */
const waiting = state("waiting")<JoinInvite>();
/** "<owner> didn't accept your request." The answer is final. */
const declined = state("declined")<JoinInvite>();

/** The joiner opens a link or pastes text. */
const openLink = event("openLink")<{ text: string }>();
/** The joiner taps an ask row in the albums list. */
const openAsk = event("openAsk")<{ ask: AskSummary }>();
/** The joiner taps "Ask to join". */
const ask = event("ask")();
/** The joiner taps "Not now". */
const notNow = event("notNow")();
/** The joiner closes the waiting screen; the ask stays. */
const close = event("close")();
/** The joiner taps OK on the declined screen. */
const ok = event("ok")();
/** The owner's answer reached this phone. */
const answered = event("answered")<{
  code: string;
  answer: "accepted" | "declined";
  folderId?: string;
}>();

/** The request was sent. */
const sent = event("sent")();
/** The request could not be sent. */
const sendFailed = event("sendFailed")<{ message: string }>();

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
    inputs: [openLink, openAsk, ask, notNow, close, ok, answered],
    internal: [sent, sendFailed],
    outputs: [openAlbum],
    states: [idle, reviewing, sending, waiting, declined],
    initial: idle,
    clock,
    context: { error: "" } as JoinContext,
    setup: (m) => {
      for (const from of [idle, reviewing, waiting, declined]) {
        /** A link opens the screen that fits what this phone knows about it. */
        m.on(from, {
          event: openLink,
          to: [idle, reviewing, waiting, declined],
          handler: (e, { actor, context }) => {
            const parsed = parseInviteLink(e.payload.text);
            if (parsed.kind === "garbled") {
              context.set({ error: GARBLED_LINK });
              return { state: actor.snapshot().path[0] === "idle" ? idle : stay(actor) };
            }
            context.set({ error: "" });
            const invite = parsed.invite;
            const found = classify(invite);
            if (found.kind === "own" || found.kind === "member") {
              return { state: idle, emit: [openAlbum.create({ folderId: found.folderId })] };
            }
            if (found.kind === "waiting") return { state: waiting.create(invite) };
            if (found.kind === "declined") return { state: declined.create(invite) };
            return { state: reviewing.create(invite) };
          },
        });
        /** A tapped ask row shows its current answer. */
        m.on(from, {
          event: openAsk,
          to: [waiting, declined],
          handler: (e) => {
            const { ask: row } = e.payload;
            const invite = {
              code: row.code,
              owner: row.owner,
              album: row.albumName,
              ownerName: row.ownerName,
            };
            return row.status === "declined"
              ? { state: declined.create(invite) }
              : { state: waiting.create(invite) };
          },
        });
      }

      /** "Ask to join": the request goes out and the buttons lock. */
      m.on(reviewing, {
        event: ask,
        to: [sending],
        handler: (_e, { actor, context }) => {
          context.set({ error: "" });
          return { state: sending.create(actor.snapshot().payload as JoinInvite) };
        },
      });
      /** "Not now": nothing was sent. */
      m.on(reviewing, { event: notNow, to: [idle], handler: () => ({ state: idle }) });

      /** The request is handed to the phone's sharing layer. */
      m.effect(sending, {
        name: "sending",
        sends: [sent, sendFailed],
        fn: ({ signal, emit, state: current }) =>
          runInvoke(
            signal,
            () => port.ask(current.payload as JoinInvite),
            () => emit(sent.create()),
            () => emit(sendFailed.create({ message: SEND_FAILED })),
          ),
      });
      /** The request is on its way: "Waiting for <owner>". */
      m.on(sending, {
        event: sent,
        to: [waiting],
        handler: (_e, { actor }) => ({
          state: waiting.create(actor.snapshot().payload as JoinInvite),
        }),
      });
      /** The send failed: back to the question, with the error shown. */
      m.on(sending, {
        event: sendFailed,
        to: [reviewing],
        handler: (e, { actor, context }) => {
          context.set({ error: e.payload.message });
          return { state: reviewing.create(actor.snapshot().payload as JoinInvite) };
        },
      });

      /** The joiner closes the screen; the request stays pending. */
      m.on(waiting, { event: close, to: [idle], handler: () => ({ state: idle }) });
      /** The owner answered. Only an answer for this request counts. */
      m.on(waiting, {
        event: answered,
        to: [idle, declined, waiting],
        handler: (e, { actor }) => {
          const invite = actor.snapshot().payload as JoinInvite;
          if (e.payload.code !== invite.code) return { state: waiting.create(invite) };
          if (e.payload.answer === "declined") return { state: declined.create(invite) };
          const folderId = e.payload.folderId;
          return folderId === undefined
            ? { state: waiting.create(invite) }
            : { state: idle, emit: [openAlbum.create({ folderId })] };
        },
      });

      /** The joiner acknowledges the answer. */
      m.on(declined, { event: ok, to: [idle], handler: () => ({ state: idle }) });
    },
  });
}

function stay(actor: { snapshot(): { path: string[]; payload?: unknown } }) {
  const snap = actor.snapshot();
  const invite = snap.payload as JoinInvite;
  switch (snap.path[0]) {
    case "reviewing":
      return reviewing.create(invite);
    case "waiting":
      return waiting.create(invite);
    default:
      return declined.create(invite);
  }
}
