import { RealClock, type Snapshot } from "@mantaq/core";
import {
  chooseLinkTime,
  createInviteLinkActor,
  createLink,
  type ValidFor,
} from "./invite-link-machine";

/** What the invite panel draws: which state, for which album, and when the link ends. */
export type InviteLinkView = {
  state: "noLinkYet" | "linkMade";
  folderId: string;
  validFor: ValidFor;
  expiresAt?: number;
};

/** What the invite panel draws, as a pure function of the actor snapshot. */
export function inviteLinkViewOf(snapshot: Snapshot<unknown>): InviteLinkView {
  const context = snapshot.context as { folderId: string; validFor: ValidFor };
  const state = snapshot.path[0] as InviteLinkView["state"];
  return {
    state,
    folderId: context.folderId,
    validFor: context.validFor,
    ...(state === "linkMade"
      ? { expiresAt: (snapshot.payload as { expiresAt: number }).expiresAt }
      : {}),
  };
}

export const inviteLinkActor = createInviteLinkActor({ clock: RealClock() });

export const inviteLink = {
  chooseLinkTime: (validFor: ValidFor) => inviteLinkActor.send(chooseLinkTime.create({ validFor })),
  createLink: (folderId: string) => inviteLinkActor.send(createLink.create({ folderId })),
};
