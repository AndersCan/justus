import { RealClock } from "@mantaq/core";
import { gateway } from "../../gateway";
import {
  askAnswered,
  createFriendOfferActor,
  join,
  type FriendOffer,
} from "./friend-offer-machine";

export const friendOfferActor = createFriendOfferActor({
  clock: RealClock(),
  port: { joinOffer: (code, owner) => gateway.joinOffer(code, owner) },
});

export const friendOffer = {
  /** The friend taps Join on an invite row. */
  join: (offer: FriendOffer) => friendOfferActor.send(join.create({ offer })),
  /** The Admin's answer reached this phone. */
  askAnswered: (code: string, answer: "accepted" | "declined", folderId?: string) =>
    friendOfferActor.send(askAnswered.create({ code, answer, folderId })),
};
