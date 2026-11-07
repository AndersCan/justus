import { RealClock } from "@mantaq/core";
import { onOutput } from "@mantaq/sugar";
import { atom } from "nanostores";
import { gateway } from "../../gateway";
import { $router } from "../../router";
import { classifyInvite } from "../../utils/classify-invite";
import type { JoinInvite } from "../../utils/invite-link";
import type { AskSummary } from "@justus/core";
import { $asks, $folders, folders } from "../folders-machine";
import {
  answerArrived,
  askToJoin,
  closeWaiting,
  createJoinRequestActor,
  dismissDecline,
  notNow,
  openLink,
  reopenRequest,
} from "./join-request-machine";

/** What the join screens draw: which screen, whose album, and any error. */
export type JoinView = {
  state:
    | "noInvite"
    | "unusableLink"
    | "joined"
    | "decidingToAsk"
    | "sendingRequest"
    | "waitingForAnswer"
    | "declined";
  invite: JoinInvite | null;
  error: string;
};

export const $join = atom<JoinView>({ state: "noInvite", invite: null, error: "" });

export const joinActor = createJoinRequestActor({
  clock: RealClock(),
  known: (invite) => classifyInvite(invite.code, $folders.get(), $asks.get()),
  port: {
    ask: async (invite) => {
      const outcome = await gateway.ask(invite.code, invite.owner, invite.album, invite.ownerName);
      if (!outcome[0]) folders.refresh();
      return outcome;
    },
  },
});

joinActor.on("change", {
  fn: (snapshot) => {
    const name = snapshot.path[0] as JoinView["state"];
    $join.set({
      state: name,
      invite:
        name === "noInvite" || name === "unusableLink" || name === "joined"
          ? null
          : (snapshot.payload as JoinInvite),
      error: (snapshot.context as { error: string }).error,
    });
  },
});

onOutput(joinActor, (e) => {
  if (e.type === "openAlbum") {
    $router.open(`/albums/${(e.payload as { folderId: string }).folderId}`);
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
  /** The Admin's answer reached this phone. */
  answerArrived: (code: string, answer: "accepted" | "declined", folderId?: string) =>
    joinActor.send(answerArrived.create({ code, answer, folderId })),
};
