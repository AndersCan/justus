import { atom } from "nanostores";
import type { PhotoSort } from "./photo-scope";

const STORAGE_KEY = "justus:photo-sort";

/** Read the persisted timeline choice. Falls back to "added". */
export function readPhotoSort(): PhotoSort {
  try {
    if (typeof localStorage === "undefined") return "added";
    return localStorage.getItem(STORAGE_KEY) === "taken" ? "taken" : "added";
  } catch {
    return "added";
  }
}

/** Persist the timeline choice (best-effort; no-op without storage). */
export function writePhotoSort(sort: PhotoSort): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(STORAGE_KEY, sort);
  } catch {
    // storage unavailable (private mode / non-browser) — ignore
  }
}

/** Which timeline the Photos grid follows: date taken or date added. */
export const $photoSort = atom<PhotoSort>(readPhotoSort());
$photoSort.listen(writePhotoSort);
