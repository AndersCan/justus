import type { FolderSummary } from "@justus/core";
import { foldersActor, foldersViewModel } from "../machines/folders-machine";
import { joinActor } from "../machines/sharing/join-request";
import { open, routerActor, type AppPage } from "../machines/router-machine";
import { seenActor, seenReady } from "../machines/seen-machine";

export type LandingInput = {
  /** The phone app opened the page at /index.html. */
  appStart: boolean;
  route: AppPage["route"] | undefined;
  seen: "reading" | "ready" | "unreadable";
  lastAlbum: string | undefined;
  foldersSettled: boolean;
  /** The shown list (archived not included). */
  folders: Pick<FolderSummary, "id" | "notice">[];
  /** The join actor is not in noInviteOpen. */
  inviteOpen: boolean;
};

export type Landing = { kind: "wait" } | { kind: "stay" } | { kind: "open"; albumId: string };

/** Where the phone app starts: the album looked at last, or All photos. */
export function decideLanding(i: LandingInput): Landing {
  if (!i.appStart) return { kind: "stay" };
  if (i.seen === "reading") return { kind: "wait" };
  if (i.seen === "unreadable" || i.lastAlbum === undefined) return { kind: "stay" };
  // A phone start passes through /welcome until the album list arrives.
  if (i.route === "welcome") return { kind: "wait" };
  if (i.route !== "gallery") return { kind: "stay" };
  if (i.inviteOpen) return { kind: "stay" };
  if (!i.foldersSettled) return { kind: "wait" };
  const album = i.folders.find((f) => f.id === i.lastAlbum);
  // A gone album stays on All photos; the next album page opened overwrites the pointer.
  if (album !== undefined && album.notice?.kind !== "removed") {
    return { kind: "open", albumId: album.id };
  }
  return { kind: "stay" };
}

function currentInput(appStart: boolean): LandingInput {
  const f = foldersViewModel(foldersActor.snapshot());
  return {
    appStart,
    route: routerActor.snapshot().context.page?.route,
    seen: seenReady(seenActor.snapshot()),
    lastAlbum: seenActor.snapshot().context.lastAlbum,
    foldersSettled: f.settled,
    folders: f.folders,
    inviteOpen: joinActor.snapshot().path[0] !== "noInviteOpen",
  };
}

/** Opens the last album once, when the phone app starts; nothing is shown either way. */
export function landOnLastAlbum(o: { appStart: boolean }): void {
  if (!o.appStart) return;
  const stops: (() => void)[] = [];
  let done = false;
  const evaluate = () => {
    if (done) return;
    const landing = decideLanding(currentInput(o.appStart));
    if (landing.kind === "wait") return;
    done = true;
    for (const stop of stops) stop();
    if (landing.kind === "open") {
      queueMicrotask(() => {
        if (routerActor.snapshot().context.page?.route === "gallery") {
          open("/albums/" + landing.albumId, { replace: true });
        }
      });
    }
  };
  for (const actor of [routerActor, seenActor, foldersActor, joinActor]) {
    stops.push(actor.on("change", { fn: evaluate }));
  }
  evaluate();
}
