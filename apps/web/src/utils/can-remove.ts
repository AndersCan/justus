import type { Photo, Role } from "@justus/core";
import { foldersActor } from "../machines/folders-machine";

/** Whoever added a photo can remove it, and so can the Admin. Collaborators
 * cannot remove other people's photos, and Viewers cannot remove anything. */
export function canRemove(photo: Pick<Photo, "mine">, role: Role): boolean {
  if (role === "reader") return false;
  return role === "creator" || photo.mine === true;
}

/** This device's role in the album a photo belongs to; a Viewer when unknown. */
export function roleFor(photo: Pick<Photo, "folderId">): Role {
  return (
    foldersActor.snapshot().context.folders.find((f) => f.id === photo.folderId)?.role ?? "reader"
  );
}

/** What the confirm dialog says a remove does. */
export function removeDetail(photo: Pick<Photo, "mine" | "member">): string {
  if (photo.mine) {
    return "Removes it from the album for everyone. Phones that already have it may keep a copy.";
  }
  return `Hides it from the album for everyone. It stays on ${photo.member.name}'s phone.`;
}
