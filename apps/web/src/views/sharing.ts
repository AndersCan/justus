import { html } from "lit-html";
import { watch } from "@mantaq/lit";
import { foldersActor } from "../machines/folders-machine";
import { requestsActor } from "../machines/requests-machine";
import { albumsPanel, joinPanel, pendingAsks } from "./albums";
import { tabs } from "./tabs";

import { copy, t } from "../copy/copy";

/** Renders `view` with the number of things waiting for this person: join requests to answer plus friends' invites to join. */
export function waitingForYou<T>(view: (waiting: number) => T) {
  return watch(requestsActor, (q) =>
    watch(foldersActor, (f) => view(q.context.requests.length + f.context.offers.length)),
  );
}

export type SharingTab = "albums" | "join";

/** Sharing: your albums' people and invites, and joining with an invite link. */
export function sharingView(tab: SharingTab) {
  return html`
    <div class="max-w-2xl space-y-5">
      <h1 class="text-2xl font-semibold tracking-tight text-fg">${t("sharing.sharing_2")}</h1>
      ${waitingForYou((waiting) =>
        tabs(
          copy("sharing.sharing_2"),
          [
            {
              id: "albums",
              label: copy("sharing.your_albums"),
              href: "/sharing",
              badge: waiting,
            },
            { id: "join", label: copy("sharing.join_an_album"), href: "/join" },
          ],
          tab,
        ),
      )}
      ${tab === "albums" ? albumsPanel() : html`${pendingAsks()} ${joinPanel()}`}
    </div>
  `;
}
