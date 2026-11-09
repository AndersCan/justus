import type { DeletedPhoto, Role } from "@justus/core";

/** What one listing of an album showed, kept to compare with the next. */
export type Listing = {
  seq: number;
  role: Role;
  /** `rt.record.notice?.kind` */
  notice: string | undefined;
  /** False when a drive scan or the removed list could not be read. */
  complete: boolean;
  /** Drive key -> the drive object listed. */
  sources: ReadonlyMap<string, object>;
  /** "<driveKey>:<id>" */
  photos: ReadonlyMap<string, { id: string; driveKey: string; name: string; adderName: string }>;
};

/** Names shown while a phone's real name is not known yet. */
const PLACEHOLDER_NAMES: ReadonlySet<string> = new Set(["Unknown device", "New member"]);

/** The drive keys of photos in `prev` that `now` no longer lists. */
export function vanishedDrives(prev: Listing | undefined, now: Listing): Set<string> {
  const keys = new Set<string>();
  if (prev === undefined) return keys;
  for (const [key, photo] of prev.photos) if (!now.photos.has(key)) keys.add(photo.driveKey);
  return keys;
}

/**
 * The photos in `prev` that `now` no longer shows because someone else deleted
 * them. Returns nothing when the drives do not prove it: a first listing, a
 * role change, a moved album, an unreadable drive, or a drive that was swapped.
 */
export function deletedSince(
  prev: Listing | undefined,
  now: Listing,
  ctx: {
    removed: Record<string, unknown>;
    selfKey: string;
    adminName: string | undefined;
    deletedHere: ReadonlySet<string>;
    /** Photo ids this phone's own holding record lists; undefined while that record is not read. */
    heldHere: ReadonlySet<string> | undefined;
    /** Drive keys whose owner left the album: their photos went with them. */
    left: ReadonlySet<string>;
  },
): DeletedPhoto[] {
  if (prev === undefined) return [];
  if (prev.role !== now.role) return [];
  if (prev.notice !== undefined || now.notice !== undefined) return [];
  if (!prev.complete || !now.complete) return [];

  const gone: DeletedPhoto[] = [];
  for (const [key, photo] of prev.photos) {
    if (now.photos.has(key)) continue;
    if (ctx.deletedHere.has(key)) continue;
    if (ctx.left.has(photo.driveKey)) continue;
    const source = prev.sources.get(photo.driveKey);
    if (source === undefined || source !== now.sources.get(photo.driveKey)) continue;
    const mine = photo.driveKey === ctx.selfKey;
    let deleter: string | undefined;
    if (ctx.removed[key] !== undefined) deleter = ctx.adminName;
    else if (mine) continue;
    else deleter = photo.adderName;
    gone.push({
      name: photo.name,
      adderName: photo.adderName,
      mine,
      ...(mine || ctx.heldHere !== undefined ? { held: mine || ctx.heldHere?.has(photo.id) } : {}),
      ...(deleter !== undefined && !PLACEHOLDER_NAMES.has(deleter) ? { deletedBy: deleter } : {}),
    });
  }
  return gone;
}
