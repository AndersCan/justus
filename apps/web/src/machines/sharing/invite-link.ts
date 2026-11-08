import { RealClock, type Snapshot } from "@mantaq/core";
import { onOutput } from "@mantaq/sugar";
import { gateway } from "../../gateway";
import { toast } from "../../views/toast";
import { sync } from "../sync-machine";
import {
  chooseLinkTime,
  createInviteLinkActor,
  createLink,
  turnOffLink,
  type ValidFor,
} from "./invite-link-machine";

import { copy } from "../../copy/copy";
/** What the invite panel draws: which state, for which album, and when the link ends. */
export type InviteLinkView = {
  state: "noLinkYet" | "savingLinkTime" | "linkMade" | "turningOff";
  folderId: string;
  validFor: ValidFor;
  /** The code that was just turned off; a link must not carry it. */
  offCode: string;
  /** The album whose links were just turned off; "" when none. */
  offFolderId: string;
  expiresAt?: number;
};

/** What the invite panel draws, as a pure function of the actor snapshot. */
export function inviteLinkViewOf(snapshot: Snapshot<unknown>): InviteLinkView {
  const context = snapshot.context as {
    folderId: string;
    validFor: ValidFor;
    offCode: string;
    offFolderId: string;
  };
  const state = snapshot.path[0] as InviteLinkView["state"];
  return {
    state,
    folderId: context.folderId,
    validFor: context.validFor,
    offCode: context.offCode,
    offFolderId: context.offFolderId,
    ...(state === "linkMade"
      ? { expiresAt: (snapshot.payload as { expiresAt: number }).expiresAt }
      : {}),
  };
}

export const inviteLinkActor = createInviteLinkActor({
  clock: RealClock(),
  port: {
    saveLinkTime: (folderId, expiresAt) => gateway.saveInviteLink(folderId, expiresAt),
    turnOff: async (folderId) => {
      const outcome = await gateway.turnOffInvite(folderId);
      if (!outcome[0]) sync.refresh();
      return outcome;
    },
  },
});

onOutput(inviteLinkActor, (e) => {
  if (e.type === "linkTurnedOff") toast(copy("invite_link.links_turned_off"));
  if (e.type === "linkNotSaved") toast(copy("invite_link.couldn_t_make_the_link"));
  if (e.type === "turnOffFailed") toast(copy("invite_link.couldn_t_turn_off_the"));
});

export const inviteLink = {
  chooseLinkTime: (validFor: ValidFor) => inviteLinkActor.send(chooseLinkTime.create({ validFor })),
  createLink: (folderId: string, code: string) =>
    inviteLinkActor.send(createLink.create({ folderId, code })),
  turnOffLink: (folderId: string, code: string) =>
    inviteLinkActor.send(turnOffLink.create({ folderId, code })),
};
