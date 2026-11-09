import type { DeletedPhoto, DeletedPhotos } from "@justus/core";
import { copy } from "../copy/copy";
import { toast } from "./toast";

export type DeletedIn = DeletedPhotos & { folderId: string };

const MERGE_MS = 300;
const HOLD_MS = 8000;

/** The note for the albums' deleted photos: one sentence per batch. */
export function deletedNoteText(albums: readonly DeletedPhotos[]): string {
  const first = albums[0];
  if (first === undefined) return "";
  const n = albums.reduce((sum, a) => sum + a.photos.length, 0);
  if (albums.length > 1) return copy("deleted_note.were_deleted_albums", { n });
  const album = first.albumName;
  const [one] = first.photos;
  if (first.photos.length === 1 && one !== undefined) return oneText(one, album);
  const by = first.photos[0]?.deletedBy;
  if (by !== undefined && first.photos.every((p) => p.deletedBy === by)) {
    return copy("deleted_note.deleted_several", { name: by, n, album });
  }
  return copy("deleted_note.were_deleted_several", { n, album });
}

function oneText(p: DeletedPhoto, album: string): string {
  const photo = p.name;
  if (p.deletedBy !== undefined) {
    const name = p.deletedBy;
    return p.mine
      ? copy("deleted_note.deleted_one_yours", { name, photo, album })
      : copy("deleted_note.deleted_one", { name, photo, album });
  }
  return p.mine
    ? copy("deleted_note.was_deleted_one_yours", { photo, album })
    : copy("deleted_note.was_deleted_one", { adder: p.adderName, photo, album });
}

let pending: DeletedIn[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;

function flush() {
  const albums = pending;
  pending = [];
  timer = undefined;
  toast(deletedNoteText(albums), { duration: HOLD_MS });
}

/** Handles deleted pushes. An object so tests can spy on it. Pushes within 300 ms make one toast. */
export const deletedNote = {
  add(change: DeletedIn): void {
    const into = pending.find((a) => a.folderId === change.folderId);
    if (into) into.photos = [...into.photos, ...change.photos];
    else pending = [...pending, { ...change, photos: [...change.photos] }];
    clearTimeout(timer);
    timer = setTimeout(flush, MERGE_MS);
  },
};
