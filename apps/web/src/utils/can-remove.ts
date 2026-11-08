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

/** Which line says why this phone can't delete the photo; undefined when it can, or the album is unknown or removed. */
export function whyNoDelete(
  photo: Pick<Photo, "mine">,
  album: Pick<FolderSummary, "role" | "notice"> | undefined,
): "viewer" | "adder_admin" | undefined {
  if (album === undefined || album.notice?.kind === "removed") return undefined;
  if (canRemove(photo, album.role)) return undefined;
  switch (album.role) {
    case "reader":
      return "viewer";
    default:
      return "adder_admin";
  }
}
