import { Actor, RealClock, event, state } from "@mantaq/core";
import { atom, computed } from "nanostores";
import { bindStateAtoms } from "./actor-utils";
import { sync } from "./sync-machine";
import { parseInvite, type Invite } from "../utils/invite";

/**
 * Receiving an invite (pasted, scanned or opened from a link): parse it, show
 * the consent text, and only join once the person confirms.
 */

const INVITE_STATES = ["idle", "reviewing"] as const;
export type InviteStateName = (typeof INVITE_STATES)[number];

export const $invite = atom<Invite | null>(null);
export const $inviteState = atom<InviteStateName>("idle");
export const $inviteError = atom<string | null>(null);
export const $inviteFatal = atom(false);

export const $inviteViewModel = computed(
  [$invite, $inviteState, $inviteError, $inviteFatal],
  (invite, state, error, fatal) => ({ invite, state, error, fatal }),
);

/** No invite is being looked at; the person can paste or scan one. */
const idle = state("idle")();
/** An invite was read and its details are on screen, waiting for the person to join or cancel. */
const reviewing = state("reviewing")();

/** The person pastes, scans or opens an invite. */
const receive = event("RECEIVE")<{ text: string }>();
/** The person agrees to join the shared folder shown. */
const confirm = event("CONFIRM")();
/** The person backs out of the invite without joining. */
const cancel = event("CANCEL")();

export const inviteActor = Actor({
  inputs: [receive, confirm, cancel],
  internal: [],
  outputs: [],
  states: [idle, reviewing],
  initial: idle,
  clock: RealClock(),
  context: {},
  setup: (m) => {
    for (const from of [idle, reviewing]) {
      /** A pasted invite is checked. If it is incomplete or garbled, the person is told to check they copied all of it and stays where they were; if it is valid, its details are shown for review (a new invite replaces one already on screen). */
      m.on(from, {
        event: receive,
        to: [idle, reviewing],
        handler: (e) => {
          const invite = parseInvite(e.payload.text);
          if (!invite) {
            $inviteError.set("That invite doesn't look right. Check you copied all of it.");
            return { state: from };
          }
          $inviteError.set(null);
          $invite.set(invite);
          return { state: reviewing };
        },
      });
    }
    /** The person joins the folder from the invite and is back at the start. */
    m.on(reviewing, {
      event: confirm,
      to: [idle],
      handler: () => {
        const invite = $invite.get();
        if (invite) sync.join(invite.key, invite.name);
        $invite.set(null);
        return { state: idle };
      },
    });
    /** The invite is dropped and nothing is joined. */
    m.on(reviewing, {
      event: cancel,
      to: [idle],
      handler: () => {
        $invite.set(null);
        return { state: idle };
      },
    });
  },
});

bindStateAtoms({
  actor: inviteActor,
  states: INVITE_STATES,
  $state: $inviteState,
  $error: $inviteError,
  $fatal: $inviteFatal,
});

export const invites = {
  receive: (text: string) => inviteActor.send(receive.create({ text })),
  confirm: () => inviteActor.send(confirm.create()),
  cancel: () => inviteActor.send(cancel.create()),
  clearError: () => $inviteError.set(null),
};
