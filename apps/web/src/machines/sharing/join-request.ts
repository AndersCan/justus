import { RealClock, type Snapshot } from "@mantaq/core";
import { onOutput } from "@mantaq/sugar";
import { gateway } from "../../gateway";
import { currentPage, open } from "../router-machine";
import { classifyInvite } from "../../utils/classify-invite";
import type { JoinInvite } from "../../utils/invite-link";
import type { AskSummary } from "@justus/core";
import { folders, foldersActor } from "../folders-machine";
import {
  requestAnswered,
  askToJoin,
  closeWaiting,
  createJoinRequestActor,
  dismissDecline,
  dismissExpired,
  notNow,
  openLink,
  reopenRequest,
} from "./join-request-machine";

/** What the join screens draw: which screen, whose album, and any error. */
export type JoinView = {
  state:
    | "noInviteOpen"
    | "showingLinkProblem"
    | "joinedAlbum"
    | "decidingToAsk"
    | "sendingRequest"
    | "waitingForAdminToAccept"
    | "declinedByAdmin"
    | "linkExpired";
  invite: JoinInvite | null;
  error: string;
};

/** What the join screens draw, as a pure function of the actor snapshot. */
export function joinViewOf(snapshot: Snapshot<unknown>): JoinView {
  const name = snapshot.path[0] as JoinView["state"];
  return {
    state: name,
    invite:
      name === "noInviteOpen" || name === "showingLinkProblem" || name === "joinedAlbum"
        ? null
        : (snapshot.payload as JoinInvite),
    error: (snapshot.context as { error: string }).error,
  };
}

export const joinActor = createJoinRequestActor({
  clock: RealClock(),
  known: (invite) =>
    classifyInvite(
      invite.code,
      foldersActor.snapshot().context.folders,
      foldersActor.snapshot().context.asks,
    ),
  asked: (code) => foldersActor.snapshot().context.asks.find((a) => a.code === code),
  port: {
    ask: async (invite) => {
      const outcome = await gateway.ask(invite.code, invite.owner, invite.album, invite.ownerName);
      if (!outcome[0]) folders.refresh();
      return outcome;
    },
  },
});

onOutput(joinActor, (e) => {
  if (e.type === "openAlbum") {
    open(`/albums/${(e.payload as { folderId: string }).folderId}`, {
      replace: currentPage()?.route === "welcome",
    });
  }
  if (e.type === "dismissDeclinedAsk") {
    void gateway
      .dismissDeclinedAsk((e.payload as { code: string }).code)
      .then(() => folders.refresh());
  }
});

export const join = {
  /** Pasted text, a scanned code or a link the host opened. */
  openLink: (text: string) => joinActor.send(openLink.create({ text })),
  /** A tapped request row in the albums list. */
  reopenRequest: (row: AskSummary) => joinActor.send(reopenRequest.create({ ask: row })),
  askToJoin: () => joinActor.send(askToJoin.create()),
  notNow: () => joinActor.send(notNow.create()),
  closeWaiting: () => joinActor.send(closeWaiting.create()),
  dismissDecline: () => joinActor.send(dismissDecline.create()),
  dismissExpired: () => joinActor.send(dismissExpired.create()),
  /** The Admin's answer reached this phone. */
  requestAnswered: (code: string, answer: "accepted" | "declined", folderId?: string) =>
    joinActor.send(requestAnswered.create({ code, answer, folderId })),
};
