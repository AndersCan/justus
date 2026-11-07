import { html } from "lit-html";
import type { DeletedAlbum, FolderSummary, SyncStatus } from "@justus/core";

/** The line under an album's title when it moved to a new key; none otherwise. */
export function albumNoticeText(notice: FolderSummary["notice"]): string | null {
  if (!notice) return null;
  if (notice.kind === "newKey") return "This album has a new key. Invite your members again.";
  return `This album has a new key. Ask ${notice.ownerName || "the Admin"} for a new invite link.`;
}

/** The line on Your albums after the Admin deleted an album for everyone. */
export function deletedNoticeText(d: DeletedAlbum): string {
  return `${d.adminName || "The Admin"} deleted “${d.name}”. The album and its photos were removed from this phone.`;
}

/** The lines shown on every page when a phone runs another Justus version. */
export function updateLines(
  status: Pick<SyncStatus, "updateNeeded" | "peersBehind"> | null,
): string[] {
  if (!status) return [];
  const lines = status.updateNeeded ? ["Update Justus to keep syncing"] : [];
  for (const name of status.peersBehind) lines.push(`${name} needs to update Justus`);
  return lines;
}

export function albumNotice(notice: FolderSummary["notice"]) {
  const text = albumNoticeText(notice);
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
