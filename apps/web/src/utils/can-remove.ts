import type { FolderSummary, Photo, Role } from "@justus/core";

/** Whoever added a photo can delete it, and so can the Admin. Members
 * cannot delete other people's photos, and Viewers cannot delete anything. */
export function canRemove(photo: Pick<Photo, "mine">, role: Role): boolean {
  if (role === "reader") return false;
  return role === "creator" || photo.mine === true;
}

/** This device's role in the album a photo belongs to; a Viewer when unknown. */
export function roleFor(
  photo: Pick<Photo, "folderId">,
  folders: readonly Pick<FolderSummary, "id" | "role">[],
): Role {
  return folders.find((f) => f.id === photo.folderId)?.role ?? "reader";
}
