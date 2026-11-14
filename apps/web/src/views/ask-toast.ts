import { onOutput } from "@mantaq/sugar";
import type { JoinRequest } from "@justus/core";
import { copy } from "../copy/copy";
import { friendsActor } from "../machines/friends-machine";
import { requestsActor, requestsArrived } from "../machines/requests-machine";
import { currentPage, onPageChange, open, type AppPage } from "../machines/router-machine";
import { requestRowOf } from "../utils/people";
import { toast } from "./toast";

/** The ask message to show, or none. Asks for the album on screen are dropped: its page shows the row arriving. */
export function askToast(
  arrived: JoinRequest[],
  page: AppPage | undefined,
  friends: Record<string, string>,
): { text: string; path: string } | undefined {
  const onScreen = page?.route === "album" ? page.params.id : undefined;
  const asks = arrived.filter((r) => r.folderId !== onScreen);
  const [first] = asks;
  if (first === undefined) return undefined;
  if (asks.length > 1) {
    return {
      text: copy("ask_toast.people_want_to_join", { count: asks.length }),
      path: "/sharing",
    };
  }
  const row = requestRowOf(first, friends);
  const path = `/sharing/${encodeURIComponent(first.folderId)}`;
  const text =
    row.clash === undefined
      ? copy("ask_toast.wants_to_join", { name: row.name, folderName: first.folderName })
      : copy("ask_toast.someone_wants_to_join", { folderName: first.folderName });
  return { text, path };
}

let shown: { path: string; close: () => void } | undefined;

/** Raises the ask toast for newly arrived requests; opening its album closes it. */
export function raiseAsk(requests: JoinRequest[]): void {
  const ask = askToast(requests, currentPage(), friendsActor.snapshot().context.friends);
  if (!ask) return;
  const close = toast(ask.text, {
    action: { label: copy("ask_toast.review"), run: () => open(ask.path) },
  });
  shown = { path: ask.path, close };
}

onOutput(requestsActor, (e) => {
  if (e.type !== requestsArrived.type) return;
  raiseAsk((e.payload as { requests: JoinRequest[] }).requests);
});

onPageChange((page) => {
  if (!shown || page?.route !== "album") return;
  if (shown.path !== `/sharing/${encodeURIComponent(page.params.id)}`) return;
  shown.close();
  shown = undefined;
});
