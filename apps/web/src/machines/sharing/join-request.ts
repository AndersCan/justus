import type { Snapshot } from "@mantaq/core";
import { onOutput } from "@mantaq/sugar";
import { gateway } from "../../gateway";
import { currentPage, onPageChange, open } from "../router-machine";
import { classifyInvite } from "../../utils/classify-invite";
import type { AskSummary } from "@justus/core";
import { folders, foldersActor } from "../folders-machine";
import {
  requestAnswered,
  whoMustUpdateChanged,
  welcomeStarted,
  welcomeEnded,
  pasteFoundNothing,
  askAgain,
  askToJoin,
  askWithPastedLink,
  albumClosed,
  linkEdited,
  cancelRequest,
  closeStoppedLink,
  closeWaiting,
  joinRequestMachine,
  namesHeard,
  type JoinScreen,
  dismissDecline,
  dismissExpired,
  notNow,
  openLink,
  reopenRequest,
  type RequestAnswer,
} from "./join-request-machine";

export const JOIN_STATES = [
  "noInviteOpen",
  "showingLinkProblem",
  "joinedAlbum",
  "alreadyInAlbum",
  "checkingLink",
  "checkingPastedLink",
  "decidingToAsk",
  "showingWelcome",
  "holdingInviteUntilWelcomeEnds",
  "sendingRequest",
  "sendingRequestAgain",
  "sendingPastedRequest",
  "waitingForAdminToAccept",
  "waitingForYouToUpdate",
  "declinedByAdmin",
  "linkExpired",
  "linkTurnedOffByAdmin",
  "linkEndedByAdmin",
  "linkReplacedByAdmin",
  "albumDeletedByAdmin",
  "linkStoppedForUnknownReason",
] as const;

/** What the join screens draw: which screen, whose album, and any error. */
export type JoinView = {
  state: (typeof JOIN_STATES)[number];
  invite: JoinScreen | null;
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
      name === "joinedAlbum" ||
      name === "alreadyInAlbum"
        ? null
        : (snapshot.payload as JoinScreen),
    error: (snapshot.context as { error: string }).error,
  };
}

/** The album this phone was just let into, while the join screen is in that state. */
export function joinedNow(snapshot: Snapshot<unknown>): { folderId: string } | undefined {
  return snapshot.path[0] === "joinedAlbum"
    ? (snapshot.payload as { folderId: string })
    : undefined;
}

export const joinActor = joinRequestMachine.create({
  known: (invite) =>
    classifyInvite(
      invite.code,
      foldersActor.snapshot().context.folders,
      foldersActor.snapshot().context.asks,
      invite.expiresAt,
    ),
  asked: (code) => foldersActor.snapshot().context.asks.find((a) => a.code === code),
  port: {
    ask: async (invite) => {
      const outcome = await gateway.ask(invite.code, invite.owner, invite.expiresAt);
      if (!outcome[0]) folders.refresh();
      return outcome;
    },
    checkLink: (invite) => gateway.linkTurnedOff(invite.code, invite.owner),
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

onPageChange((_page, old) => {
  const now = joinedNow(joinActor.snapshot());
  if (now !== undefined && old?.route === "photoAlbum" && old.params.id === now.folderId) {
    joinActor.send(albumClosed.create());
  }
});

/**
 * Tells the join screen when the open waiting request's Admin is on another Justus.
 * Sends only when the screen would change.
 */
export function wireAsksToJoin(
  foldersSource: {
    snapshot(): {
      context: {
        asks: readonly {
          code: string;
          albumName: string;
          ownerName: string;
          whoMustUpdate?: "you";
        }[];
      };
    };
    on(event: "change", options: { fn: () => void }): () => void;
  },
  target: {
    snapshot(): Snapshot<unknown>;
    send(
      e: ReturnType<typeof whoMustUpdateChanged.create> | ReturnType<typeof namesHeard.create>,
    ): unknown;
  },
): () => void {
  return foldersSource.on("change", {
    fn: () => {
      const snap = target.snapshot();
      const name = snap.path[0];
      if (name !== "waitingForAdminToAccept" && name !== "waitingForYouToUpdate") return;
      const shown = snap.payload as JoinScreen;
      const { code } = shown;
      const ask = foldersSource.snapshot().context.asks.find((a) => a.code === code);
      if (
        ask !== undefined &&
        ask.albumName !== "" &&
        (ask.albumName !== shown.album || ask.ownerName !== shown.ownerName)
      ) {
        target.send(namesHeard.create({ code, album: ask.albumName, ownerName: ask.ownerName }));
      }
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
  /** "Ask to join" under the paste box. */
  askWithPastedLink: (text: string) => joinActor.send(askWithPastedLink.create({ text })),
  /** The text in the paste box changed. */
  linkEdited: () => joinActor.send(linkEdited.create()),
  askToJoin: () => joinActor.send(askToJoin.create()),
  notNow: () => joinActor.send(notNow.create()),
  cancelRequest: () => joinActor.send(cancelRequest.create()),
  closeWaiting: () => joinActor.send(closeWaiting.create()),
  dismissDecline: () => joinActor.send(dismissDecline.create()),
  askAgain: () => joinActor.send(askAgain.create()),
  dismissExpired: () => joinActor.send(dismissExpired.create()),
  closeStoppedLink: () => joinActor.send(closeStoppedLink.create()),
  /** The Admin's answer reached this phone. */
  requestAnswered: (answer: RequestAnswer) => joinActor.send(requestAnswered.create(answer)),
};
