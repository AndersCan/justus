import type { Snapshot } from "@mantaq/core";
import { onOutput } from "@mantaq/sugar";
import { gateway } from "../../gateway";
import { toast } from "../../views/toast";
import { sync } from "../sync-machine";
import {
  chooseLinkTime,
  inviteLinkMachine,
  createLink,
  endLink,
  makeNewLink,
  linkReplaced,
  turnOffLink,
  type ValidFor,
} from "./invite-link-machine";

import { copy } from "../../copy/copy";
/** What the invite panel draws: which state, for which album, and when the link ends. */
export type InviteLinkView = {
  state: "noLinkYet" | "savingLinkTime" | "linkMade" | "turningOff" | "endingLink";
  folderId: string;
  validFor: ValidFor;
  /** The code that was just turned off; a link must not carry it. */
  offCode: string;
  /** The album whose links were just turned off; "" when none. */
  offFolderId: string;
  /** The album whose shown link a removal replaced; "" when none. */
  replacedFolderId: string;
  /** Who was removed last, for that album's line. */
  removedName: string;
  expiresAt?: number;
  /** The code the shown link was saved for. */
  code?: string;
  /** The end of the link being ended; set while `state` is "endingLink". */
  endingEndsAt?: number;
};

/** What the invite panel draws, as a pure function of the actor snapshot. */
export function inviteLinkViewOf(snapshot: Snapshot<unknown>): InviteLinkView {
  const context = snapshot.context as {
    folderId: string;
    validFor: ValidFor;
    offCode: string;
    offFolderId: string;
    replacedFolderId: string;
    removedName: string;
  };
  const state = snapshot.path[0] as InviteLinkView["state"];
  return {
    state,
    folderId: context.folderId,
    validFor: context.validFor,
    offCode: context.offCode,
    offFolderId: context.offFolderId,
    replacedFolderId: context.replacedFolderId,
    removedName: context.removedName,
    ...(state === "linkMade"
      ? {
          expiresAt: (snapshot.payload as { expiresAt: number; code: string }).expiresAt,
          code: (snapshot.payload as { expiresAt: number; code: string }).code,
        }
      : {}),
    ...(state === "endingLink"
      ? { endingEndsAt: (snapshot.payload as { endsAt: number }).endsAt }
      : {}),
  };
}

export const inviteLinkActor = inviteLinkMachine.create({
  port: {
    saveLinkTime: async (folderId, expiresAt) => {
      const outcome = await gateway.saveInviteLink(folderId, expiresAt);
      if (!outcome[0]) sync.refresh();
      return outcome;
    },
    endLink: async (folderId, endsAt) => {
      const outcome = await gateway.endInviteLink(folderId, endsAt);
      if (!outcome[0]) sync.refresh();
      return outcome;
    },
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
  if (e.type === "linkEnded") toast(copy("invite_link.link_ended"));
  if (e.type === "endLinkFailed") toast(copy("invite_link.couldn_t_end_the_link"));
  if (e.type === "turnOffFailed") toast(copy("invite_link.couldn_t_turn_off_the"));
});

export const inviteLink = {
  chooseLinkTime: (validFor: ValidFor) => inviteLinkActor.send(chooseLinkTime.create({ validFor })),
  createLink: (folderId: string, code: string) =>
    inviteLinkActor.send(createLink.create({ folderId, code })),
  linkReplaced: (folderId: string, code: string, name: string) =>
    inviteLinkActor.send(linkReplaced.create({ folderId, code, name })),
  makeNewLink: (folderId: string, code: string) =>
    inviteLinkActor.send(makeNewLink.create({ folderId, code })),
  endLink: (folderId: string, link: { endsAt: number }) =>
    inviteLinkActor.send(endLink.create({ folderId, ...link })),
  turnOffLink: (folderId: string, code: string) =>
    inviteLinkActor.send(turnOffLink.create({ folderId, code })),
};
