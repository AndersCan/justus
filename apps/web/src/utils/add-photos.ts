import type { FolderSummary } from "@justus/core";

import { copy } from "../copy/copy";
/** Whether the album on screen can take photos, decided before the picker
 * opens so a dead end never costs the user a pick. Photos are only ever
 * added from inside an album, so where they go is never a guess. */
export type AddPlan =
  /** The album takes them. */
  | { kind: "direct"; folderId: string }
  /** The user can view the album but not add to it (Reader / Viewer). */
  | { kind: "viewer"; album: FolderSummary }
  /** The user is still waiting for the Admin's approval. */
  | { kind: "pending"; album: FolderSummary };

export function planAdd(folderId: string, folders: FolderSummary[]): AddPlan {
  const album = folders.find((f) => f.id === folderId);
  if (!album) return { kind: "direct", folderId };
  if (album.pending) return { kind: "pending", album };
  if (album.role === "reader") return { kind: "viewer", album };
  return { kind: "direct", folderId: album.id };
}

/** Only images can be added; drops and pastes may carry anything. */
export function imageFiles(files: Iterable<File> | ArrayLike<File> | null | undefined): File[] {
  return files ? Array.from(files).filter((f) => f.type.startsWith("image/")) : [];
}

/** The line shown when a batch finishes. */
export function batchSummary(
  batch: { added: number; duplicates: number; failed: unknown[] },
  album: string,
): string {
  const { added, duplicates } = batch;
  const failed = batch.failed.length;
  if (failed > 0) {
    const lead =
      failed === 1
        ? copy("add_photos.1_photo_couldn_t_be")
        : copy("add_photos.photos_couldn_t_be_added", { failed });
    return added > 0
      ? copy("add_photos.added_to", { lead, added, album })
      : copy("add_photos.to", { lead, album });
  }
  if (added === 0) {
    return duplicates === 1
      ? copy("add_photos.that_photo_is_already_in", { album })
      : copy("add_photos.those_photos_are_already_in", { album });
  }
  const lead =
    added === 1
      ? copy("add_photos.added_a_photo_to", { album })
      : copy("add_photos.added_photos_to", { added, album });
  return duplicates > 0 ? copy("add_photos.already_there", { lead, duplicates }) : lead;
}
