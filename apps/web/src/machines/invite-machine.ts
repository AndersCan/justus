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

const idle = state("idle")();
const reviewing = state("reviewing")();

const receive = event("RECEIVE")<{ text: string }>();
const confirm = event("CONFIRM")();
const cancel = event("CANCEL")();

const inviteActor = new Actor({
  inputs: [receive, confirm, cancel],
  internal: [],
  outputs: [],
  states: [idle, reviewing],
  initial: idle,
  clock: new RealClock(),
  context: {},
  setup: (m) => {
    for (const from of [idle, reviewing]) {
      m.on(from, receive, (e) => {
        const invite = parseInvite(e.payload.text);
        if (!invite) {
          $inviteError.set("That invite doesn't look right. Check you copied all of it.");
          return { state: from };
        }
        $inviteError.set(null);
        $invite.set(invite);
        return { state: reviewing };
      });
    }
    m.on(reviewing, confirm, () => {
      const invite = $invite.get();
      if (invite) sync.join(invite.key);
      $invite.set(null);
      return { state: idle };
    });
    m.on(reviewing, cancel, () => {
      $invite.set(null);
      return { state: idle };
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
