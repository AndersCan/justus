import type { FolderSummary } from "@justus/core";

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
    const lead = failed === 1 ? "1 photo couldn't be added" : `${failed} photos couldn't be added`;
    return added > 0 ? `${lead}. ${added} added to ${album}.` : `${lead} to ${album}.`;
  }
  if (added === 0) {
    return duplicates === 1
      ? `That photo is already in ${album}`
      : `Those photos are already in ${album}`;
  }
  const lead = added === 1 ? `Added a photo to ${album}` : `Added ${added} photos to ${album}`;
  return duplicates > 0 ? `${lead} · ${duplicates} already there` : lead;
}
