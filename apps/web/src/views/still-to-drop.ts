import { html } from "lit-html";
import type { SyncStatus } from "@justus/core";
import { t } from "../copy/copy";
import { nameList } from "../utils/people";
import { droppedNames } from "./dropped-toast";

export type StillToDrop = { list: string; n: number; photos: number };

/** The phones that are off and still hold a deleted photo, as the line's words need them; undefined when there are none. */
export function stillToDropParams(status: SyncStatus): StillToDrop | undefined {
  const rows = status.members.filter(
    (m, i) => i > 0 && !m.connected && (m.stillToDrop ?? []).length > 0,
  );
  if (rows.length === 0) return undefined;
  const names = droppedNames({
    folderId: status.folder.id,
    people: rows.map((m) => ({ key: m.key, name: m.name })),
  });
  return {
    list: nameList(names.map((name) => `${name}'s`)),
    n: rows.length,
    photos: new Set(rows.flatMap((m) => m.stillToDrop ?? [])).size,
  };
}

/** One line under the presence strip: whose phones still have to drop a deleted photo. */
export function stillToDropLine(status: SyncStatus) {
  const params = stillToDropParams(status);
  if (params === undefined) return null;
  return html`<p class="text-sm text-muted">
    ${t("gallery.still_to_drop", { list: params.list, n: params.n, photos: params.photos })}
  </p>`;
}
