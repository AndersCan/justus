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
  whoMustUpdateChanged,
  welcomeStarted,
  welcomeEnded,
  pasteFoundNothing,
  askToJoin,
  cancelRequest,
  closeStoppedLink,
  closeWaiting,
  createJoinRequestActor,
  dismissDecline,
  dismissExpired,
  notNow,
  openLink,
  reopenRequest,
  type RequestAnswer,
} from "./join-request-machine";

/** What the join screens draw: which screen, whose album, and any error. */
export type JoinView = {
  state:
    | "noInviteOpen"
    | "showingLinkProblem"
    | "joinedAlbum"
    | "decidingToAsk"
    | "showingWelcome"
    | "holdingInviteUntilWelcomeEnds"
    | "sendingRequest"
    | "waitingForAdminToAccept"
    | "waitingForYouToUpdate"
    | "declinedByAdmin"
    | "linkExpired"
    | "linkTurnedOffByAdmin"
    | "linkReplacedByAdmin"
    | "albumDeletedByAdmin"
    | "linkStoppedForUnknownReason";
  invite: JoinInvite | null;
  error: string;
};

/** What the join screens draw, as a pure function of the actor snapshot. */
export function joinViewOf(snapshot: Snapshot<unknown>): JoinView {
  const name = snapshot.path[0] as JoinView["state"];
  return {
    state: name,
    invite:
      name === "noInviteOpen" ||
      name === "showingWelcome" ||
      name === "showingLinkProblem" ||
      name === "joinedAlbum"
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
  if (e.type === "cancelAsk") {
    void gateway.cancelAsk((e.payload as { code: string }).code).then(() => folders.refresh());
  }
});

/**
 * Tells the join screen when the open waiting request's Admin is on another Justus.
 * Sends only when the screen would change.
 */
export function wireAsksToJoin(
  foldersSource: {
    snapshot(): { context: { asks: readonly { code: string; whoMustUpdate?: "you" }[] } };
    on(event: "change", options: { fn: () => void }): () => void;
  },
  target: {
    snapshot(): Snapshot<unknown>;
    send(e: ReturnType<typeof whoMustUpdateChanged.create>): unknown;
  },
): () => void {
  return foldersSource.on("change", {
    fn: () => {
      const snap = target.snapshot();
      const name = snap.path[0];
      if (name !== "waitingForAdminToAccept" && name !== "waitingForYouToUpdate") return;
      const { code } = snap.payload as JoinInvite;
      const ask = foldersSource.snapshot().context.asks.find((a) => a.code === code);
      const who = ask?.whoMustUpdate ?? "nobody";
      if ((who === "you") === (name === "waitingForYouToUpdate")) return;
      target.send(whoMustUpdateChanged.create({ code, who }));
    },
  });
}

wireAsksToJoin(foldersActor, joinActor);

export const join = {
  /** The first-run welcome opened. */
  welcomeStarted: () => joinActor.send(welcomeStarted.create()),
  /** The name is saved; a held link now asks. */
  welcomeEnded: () => joinActor.send(welcomeEnded.create()),
  /** Paste found nothing copied. */
  pasteFoundNothing: () => joinActor.send(pasteFoundNothing.create()),
  /** Pasted text, a scanned code or a link the host opened. */
  openLink: (text: string) => joinActor.send(openLink.create({ text })),
  /** A tapped request row in the albums list. */
  reopenRequest: (row: AskSummary) => joinActor.send(reopenRequest.create({ ask: row })),
  askToJoin: () => joinActor.send(askToJoin.create()),
  notNow: () => joinActor.send(notNow.create()),
  cancelRequest: () => joinActor.send(cancelRequest.create()),
  closeWaiting: () => joinActor.send(closeWaiting.create()),
  dismissDecline: () => joinActor.send(dismissDecline.create()),
  dismissExpired: () => joinActor.send(dismissExpired.create()),
  closeStoppedLink: () => joinActor.send(closeStoppedLink.create()),
  /** The Admin's answer reached this phone. */
  requestAnswered: (answer: RequestAnswer) => joinActor.send(requestAnswered.create(answer)),
};
