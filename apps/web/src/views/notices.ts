import { html } from "lit-html";
import type { DeletedAlbum, FolderSummary, SyncStatus } from "@justus/core";

import { copy } from "../copy/copy";
/** The line under an album's title when it moved to a new key; none otherwise. */
export function albumNoticeText(notice: FolderSummary["notice"], albumName: string): string | null {
  if (!notice) return null;
  if (notice.kind === "removed") return copy("notices.you_re_no_longer_in", { albumName });
  if (notice.kind === "newKey") return copy("notices.this_album_has_a_new");
  return copy("notices.this_album_has_a_new_2", {
    admin: notice.ownerName || copy("notices.the_admin"),
  });
}

/** The line on Your albums after the Admin deleted an album for everyone. */
export function deletedNoticeText(d: DeletedAlbum): string {
  return copy("notices.deleted_the_album_and_its", {
    admin: d.adminName || copy("notices.the_admin_2"),
    name: d.name,
  });
}

/** The lines shown on every page when a phone runs another Justus version. */
export function updateLines(
  status: Pick<SyncStatus, "updateNeeded" | "peersBehind"> | null,
): string[] {
  if (!status) return [];
  const lines = status.updateNeeded ? [copy("notices.update_justus_to_keep_syncing")] : [];
  for (const name of status.peersBehind)
    lines.push(copy("notices.needs_to_update_justus", { name }));
  return lines;
}

export function albumNotice(notice: FolderSummary["notice"], albumName: string) {
  const text = albumNoticeText(notice, albumName);
  if (!text) return null;
  return html`<p
    class="rounded-xl bg-subtle px-4 py-2.5 text-sm text-fg ring-1 ring-trust-amber/40"
    role="status"
  >
    ${text}
  </p>`;
}

export function updateBanner(lines: string[]) {
  if (lines.length === 0) return null;
  return html`<div
    class="mb-4 space-y-1 rounded-xl bg-subtle px-4 py-2.5 text-sm text-fg ring-1 ring-trust-amber/40"
    role="status"
  >
    ${lines.map((line) => html`<p>${line}</p>`)}
  </div>`;
}
