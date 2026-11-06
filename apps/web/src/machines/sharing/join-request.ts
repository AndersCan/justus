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
  answered,
  ask,
  close,
  createJoinRequestActor,
  notNow,
  ok,
  openAsk,
  openLink,
} from "./join-request-machine";

/** What the join screens draw: which screen, whose album, and any error. */
export type JoinView = {
  state: "idle" | "reviewing" | "sending" | "waiting" | "declined";
  invite: JoinInvite | null;
  error: string;
};

export const $join = atom<JoinView>({ state: "idle", invite: null, error: "" });

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
      invite: name === "idle" ? null : (snapshot.payload as JoinInvite),
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
  /** A tapped ask row in the albums list. */
  openAsk: (row: AskSummary) => joinActor.send(openAsk.create({ ask: row })),
  ask: () => joinActor.send(ask.create()),
  notNow: () => joinActor.send(notNow.create()),
  close: () => joinActor.send(close.create()),
  ok: () => joinActor.send(ok.create()),
  /** The Admin's answer reached this phone. */
  answered: (code: string, answer: "accepted" | "declined", folderId?: string) =>
    joinActor.send(answered.create({ code, answer, folderId })),
};
