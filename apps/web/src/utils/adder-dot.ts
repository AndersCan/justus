import type { Photo, SyncMember, SyncStatus } from "@justus/core";
import type { PhotoScope } from "./photo-scope";

/** Who added a photo, as its album tile shows them. `color` is their seat; none draws a hollow dot. */
export type TileAdder = { color: number | undefined; name: string };

/** The members an album grid's dots read: the open album's. None on Photos > All and
 * Added by me (a colour is chosen per album) before this album's status arrives, and on a phone removed from it. */
export function dotMembers(
  scope: PhotoScope,
  status: SyncStatus | null,
): readonly SyncMember[] | undefined {
  if (scope.kind !== "album" || status?.folder.id !== scope.id) return undefined;
  // A removed phone hides Members and the people strip, so no colour could be explained.
  return status.folder.notice?.kind === "removed" ? undefined : status.members;
}

/** A dot tells people apart only when two or more people added photos here. */
export function showsAdderDots(photos: readonly Pick<Photo, "member">[]): boolean {
  return new Set(photos.map((p) => p.member.key)).size >= 2;
}

/** The tile's adder: their seat from the album's members (none when they have none or are no longer listed). */
export function tileAdder(
  photo: Pick<Photo, "member">,
  members: readonly Pick<SyncMember, "key" | "color">[],
): TileAdder {
  return {
    color: members.find((m) => m.key === photo.member.key)?.color,
    name: photo.member.name.trim(),
  };
}
