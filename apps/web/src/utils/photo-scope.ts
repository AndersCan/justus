import type { FolderSummary, Photo } from "@justus/core";
import { formatMonthGroup, sameMonth } from "./time";

/** Which slice of the cross-album photo list the Photos page is showing. */
export type PhotoScope = { kind: "all" } | { kind: "mine" } | { kind: "album"; id: string };

/** Photos added within this window lead the timeline as "Recently added". */
export const RECENT_MS = 7 * 24 * 60 * 60 * 1000;

export function photosInScope(photos: Photo[], scope: PhotoScope): Photo[] {
  if (scope.kind === "mine") return photos.filter((p) => p.mine);
  if (scope.kind === "album") return photos.filter((p) => p.folderId === scope.id);
  return photos;
}

export type PhotoGroup = { label: string; photos: Photo[] };

/** The two timelines: when photos were taken (the real one, from EXIF) or
 * when they were added to Justus. */
export type PhotoSort = "taken" | "added";

/** When the photo was taken (ms epoch), else when it was added. A zone-less
 * `takenAt` parses as local time, so camera wall-clock time is kept. */
export function takenTime(photo: Photo): number {
  const t = photo.takenAt ? Date.parse(photo.takenAt) : NaN;
  return Number.isNaN(t) ? photo.addedAt : t;
}

const timeFor = (sort: PhotoSort) => (sort === "taken" ? takenTime : (p: Photo) => p.addedAt);

/** Newest first on the chosen timeline. Stable, so ties keep list order. */
export function sortPhotos(photos: Photo[], sort: PhotoSort): Photo[] {
  const time = timeFor(sort);
  return [...photos].sort((a, b) => time(b) - time(a));
}

/** Newest-first photos as timeline groups, one per calendar month. By date
 * added, the last week leads as "Recently added". */
export function groupPhotos(photos: Photo[], sort: PhotoSort, now = Date.now()): PhotoGroup[] {
  const time = timeFor(sort);
  const groups: PhotoGroup[] = [];
  for (const photo of sortPhotos(photos, sort)) {
    const at = time(photo);
    const label =
      sort === "added" && now - at < RECENT_MS ? "Recently added" : formatMonthGroup(at);
    const last = groups[groups.length - 1];
    const lastAt = last && time(last.photos[last.photos.length - 1]);
    if (last && last.label === label && (label === "Recently added" || sameMonth(at, lastAt))) {
      last.photos.push(photo);
    } else {
      groups.push({ label, photos: [photo] });
    }
  }
  return groups;
}

export type AlbumCard = { folder: FolderSummary; cover: Photo | null; count: number };

/** One card per album: its newest photo as the cover, and its photo count. */
export function albumCards(folders: FolderSummary[], photos: Photo[]): AlbumCard[] {
  return folders.map((folder) => {
    const own = photos.filter((p) => p.folderId === folder.id);
    return { folder, cover: own[0] ?? null, count: own.length };
  });
}

/** Albums this device can add photos to (Viewers and pending joins cannot). */
export function addTargets(folders: FolderSummary[]): FolderSummary[] {
  return folders.filter((f) => f.role !== "reader" && !f.pending);
}
