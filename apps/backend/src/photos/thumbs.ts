/**
 * Which previews this phone fetches in the background, and how. Ports only: no photo-store.
 */
import type { Drive } from "../ports/drive-store";
import { RENDITION_EXT, type PhotoHolders } from "@justus/core";
import { DRIVE_PATH_THUMBS, type GalleryLog } from "./gallery";
import { errText } from "../p2p-log.ts";

/** One preview over a slow phone link. */
export const THUMB_TIMEOUT_MS = 20_000;
export const THUMBS_AT_ONCE = 4;

export type ThumbToFetch = { id: string; driveKey: string; path: string };

/** Photos whose preview this phone lacks and some connected phone has, newest first (addedAt desc, then id). */
export function thumbsToFetch(input: {
  photos: ReadonlyArray<{
    id: string;
    driveKey: string;
    addedAt: number;
    hasThumb?: true;
    holders: PhotoHolders | undefined;
  }>;
  connected: (key: string) => boolean;
}): ThumbToFetch[] {
  const todo: { addedAt: number; item: ThumbToFetch }[] = [];
  for (const photo of input.photos) {
    const holders = photo.holders;
    if (!photo.hasThumb || holders === undefined || holders.kind !== "inAlbum") continue;
    if (holders.here || holders.previewHere) continue;
    const sources = [
      photo.driveKey,
      ...holders.others.map((m) => m.key),
      ...holders.previews.map((m) => m.key),
    ];
    if (!sources.some(input.connected)) continue;
    todo.push({
      addedAt: photo.addedAt,
      item: {
        id: photo.id,
        driveKey: photo.driveKey,
        path: `${DRIVE_PATH_THUMBS}/${photo.id}${RENDITION_EXT}`,
      },
    });
  }
  todo.sort((a, b) => b.addedAt - a.addedAt || (a.item.id < b.item.id ? -1 : 1));
  return todo.map((t) => t.item);
}

export type ThumbsRun = { fetched: number; stopped?: "timedOut" | "error" };

/** Fetches each preview, THUMBS_AT_ONCE at a time; starts no new one after the first "timedOut" or throw. */
export async function fetchThumbs(input: {
  todo: ReadonlyArray<ThumbToFetch>;
  driveOf: (driveKey: string) => Drive | undefined;
  /** Called once per preview that is now on this phone. */
  landed: (id: string) => Promise<void>;
  log: GalleryLog;
}): Promise<ThumbsRun> {
  const run: ThumbsRun = { fetched: 0 };
  let next = 0;
  const worker = async () => {
    while (run.stopped === undefined && next < input.todo.length) {
      const item = input.todo[next++];
      if (!item) break;
      const drive = input.driveOf(item.driveKey);
      if (!drive) continue;
      try {
        const found = await drive.download(item.path, { timeoutMs: THUMB_TIMEOUT_MS });
        if (found === "here") {
          await input.landed(item.id);
          run.fetched++;
        } else if (found === "timedOut") {
          run.stopped ??= "timedOut";
        }
      } catch (thrown: unknown) {
        input.log("error", { where: "thumbs.fetch", err: errText(thrown) });
        run.stopped ??= "error";
      }
    }
  };
  await Promise.all(Array.from({ length: THUMBS_AT_ONCE }, worker));
  return run;
}
