import type { FolderSummary } from "@justus/core";
import { addTargets, type PhotoScope } from "./photo-scope";

/** Where "Add photos" can put photos from the current view, decided before
 * the picker opens so a dead end never costs the user a pick. */
export type AddPlan =
  /** One album takes them: the one on screen, or the only one that can. */
  | { kind: "direct"; folderId: string }
  /** Several albums can: ask which once the photos are picked. */
  | { kind: "choose"; albums: FolderSummary[] }
  /** No albums yet: start one first. */
  | { kind: "none" }
  /** Every album here is view-only (the user is a Reader / Viewer). */
  | { kind: "viewer"; album: FolderSummary | null }
  /** The album on screen is still waiting for the Admin's approval. */
  | { kind: "pending"; album: FolderSummary };

export function planAdd(scope: PhotoScope, folders: FolderSummary[]): AddPlan {
  if (scope.kind === "album") {
    const album = folders.find((f) => f.id === scope.id);
    if (!album) return { kind: "direct", folderId: scope.id };
    if (album.pending) return { kind: "pending", album };
    if (album.role === "reader") return { kind: "viewer", album };
    return { kind: "direct", folderId: album.id };
  }
  if (folders.length === 0) return { kind: "none" };
  const targets = addTargets(folders);
  if (targets.length === 0) {
    const pending = folders.find((f) => f.pending);
    return pending ? { kind: "pending", album: pending } : { kind: "viewer", album: null };
  }
  if (targets.length === 1) return { kind: "direct", folderId: targets[0].id };
  return { kind: "choose", albums: targets };
}

const LAST_ALBUM_KEY = "justus:last-add-album";

/** The album photos were last added to, offered first in the chooser. */
export function lastAddAlbum(): string | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage.getItem(LAST_ALBUM_KEY);
  } catch {
    return null;
  }
}

export function rememberAddAlbum(folderId: string): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(LAST_ALBUM_KEY, folderId);
  } catch {
    // storage unavailable: the chooser falls back to the active album
  }
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
