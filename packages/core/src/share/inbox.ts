import type { PickedMedia } from "../media/events";

/** Folder under the worklet cacheDir where a host puts photos shared to Justus from another app. */
export const SHARED_IN_DIR = "shared-in";
export const SHARED_IN_MANIFEST = "batch.json";
export const SHARED_IN_VERSION = 1;
/** Extensions a shared original may have (lowercase, no dot). */
export const SHARED_IN_EXTS = ["jpg", "jpeg", "png", "gif", "webp", "heic"] as const;

/** One file entry as a host writes it. Paths are bare file names inside the batch dir. */
export type SharedInFile = {
  file: string;
  name?: string;
  display?: string;
  thumb?: string;
  takenAt?: string;
};

export type SharedInManifest = {
  version: 1;
  id: string;
  receivedAt: string;
  items: SharedInFile[];
};

/** What the web gets: the same shape `media.pickMany` returns, plus the original's type and a URL serving its bytes. */
export type SharedPhoto = PickedMedia & { type: string; url: string };

export type SharedBatch = { id: string; receivedAt: string; photos: SharedPhoto[] };
