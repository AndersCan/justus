import { Actor, event, state } from "@mantaq/core";
import type { Clock } from "@mantaq/core";
import { withTimeout } from "@mantaq/sugar";

/**
 * Proposed flow, not wired into the app yet: the joiner's screens, from
 * opening an invite link to being let in. It never calls `sync`.
 */

/** How long the joiner waits before being told the Admin's phone needs Justus open. */
export const ADMIN_OFFLINE_HINT_AFTER_MS = 30_000;

export type JoinRole = "reader" | "member";
export type JoinAlbum = { album: string; admin: string };

/** Reads `justus://join?i=<code>&n=<album>&a=<admin>`; undefined when it is not an invite link. */
export function parseJoinLink(text: string): JoinAlbum | undefined {
  const match = /justus:\/\/join\?([^\s]*)/i.exec(text);
  if (!match) return undefined;
  const params = new URLSearchParams(match[1]);
  const code = params.get("i");
  const album = params.get("n");
  if (!code || !/^[0-9a-z]+$/i.test(code) || !album) return undefined;
  return { album, admin: params.get("a") || "the Admin" };
}

/** No link is open. */
const idle = state("idle")();
/** "Join <album>?" is on screen with the consent text. */
const reviewing = state("reviewing")<JoinAlbum>();
/** The request is sent and the joiner sees "Waiting for <Admin>". */
const waiting = state("waiting")<JoinAlbum & { hint: boolean }>();
/** The Admin accepted. */
const joined = state("joined")<{ role: JoinRole }>();
/** The Admin did not accept. */
const declined = state("declined")();
/** The link no longer works. */
const refused = state("refused")<{ reason: "expired" | "cancelled" }>();

/** The joiner opens a link or pastes text. */
const openLink = event("openLink")<{ link: string }>();
/** The joiner taps "Ask to join". */
const ask = event("ask")();
/** The joiner backs out. */
const cancel = event("cancel")();
/** The Admin accepted the request with a role. */
const accepted = event("accepted")<{ role: JoinRole }>();
/** The Admin declined the request. */
const adminDeclined = event("adminDeclined")();
/** The Admin's phone said the link is expired or cancelled. */
const linkRefused = event("linkRefused")<{ reason: "expired" | "cancelled" }>();

/** 30 seconds passed with no answer. */
const hintDue = event("hintDue")();

/** The request that goes to the Admin's phone. */
const requestSent = event("requestSent")<JoinAlbum>();
/** The request is withdrawn. */
const requestWithdrawn = event("requestWithdrawn")();

export function createJoinRequestActor(options: { clock: Clock }) {
  return Actor({
    inputs: [openLink, ask, cancel, accepted, adminDeclined, linkRefused],
    internal: [hintDue],
    outputs: [requestSent, requestWithdrawn],
    states: [idle, reviewing, waiting, joined, declined, refused],
    initial: idle,
    clock: options.clock,
    setup: (m) => {
      /** A good link shows "Join <album>?". Anything else leaves the screen as it is. */
      m.on(idle, {
        event: openLink,
        to: [idle, reviewing],
        handler: (e) => {
          const album = parseJoinLink(e.payload.link);
          return album === undefined ? { state: idle } : { state: reviewing.create(album) };
        },
      });
      /** The joiner taps "Ask to join": the request is sent and the wait starts. */
      m.on(reviewing, {
        event: ask,
        to: [waiting],
        handler: (_e, { actor }) => {
          const album = actor.snapshot().payload as JoinAlbum;
          return {
            state: waiting.create({ ...album, hint: false }),
            emit: [requestSent.create(album)],
          };
        },
      });
      /** The joiner backs out before asking: nothing was sent. */
      m.on(reviewing, { event: cancel, to: [idle], handler: () => ({ state: idle }) });

      /** After 30 seconds: "<Admin>'s phone needs Justus open to let you in." */
      m.effect(waiting, {
        name: "adminOfflineHint",
        sends: [hintDue],
        fn: (input) =>
          withTimeout(ADMIN_OFFLINE_HINT_AFTER_MS, { input, event: () => hintDue.create() }),
      });
      /** The wait is over: the screen adds the line about the Admin's phone. */
      m.on(waiting, {
        event: hintDue,
        to: [waiting],
        handler: (_e, { actor }) => {
          const { album, admin } = actor.snapshot().payload as JoinAlbum;
          return { state: waiting.create({ album, admin, hint: true }) };
        },
      });
      /** The joiner withdraws the request. */
      m.on(waiting, {
        event: cancel,
        to: [idle],
        handler: () => ({ state: idle, emit: [requestWithdrawn.create()] }),
      });
      /** The Admin accepts as a Viewer or Collaborator. */
      m.on(waiting, {
        event: accepted,
        to: [joined],
        handler: (e) => ({ state: joined.create({ role: e.payload.role }) }),
      });
      /** The Admin declines. */
      m.on(waiting, { event: adminDeclined, to: [declined], handler: () => ({ state: declined }) });
      /** The link expired or was cancelled before the Admin's phone saw the request. */
      m.on(waiting, {
        event: linkRefused,
        to: [refused],
        handler: (e) => ({ state: refused.create({ reason: e.payload.reason }) }),
      });
    },
  });
}
