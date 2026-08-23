import type { Photo } from "@justus/core";
import { guessMime } from "./mime";

/**
 * I3 canonical gallery order: (addedAt desc, memberKey asc, id asc).
 *
 * A pure function of record data — no clock, no environment — so the derived
 * gallery is byte-identical on every replica (issue #23, invariant I3).
 * Ties on addedAt are common across devices (same-ms captures, batch
 * replication), which makes the memberKey/id tie-breakers load-bearing:
 * without them Array#sort stability would differ between replicas that
 * received the same entries in different orders.
 */
/** The canonical tie-break key for one photo, independent of whether it is a
 * raw `Photo` (member.key) or a derived gallery entry (driveKey). The two
 * comparators below reduce to this so production order matches the I3 spec. */
export interface CanonicalOrderKey {
  addedAt: number;
  memberKey: string;
  id: string;
}

/**
 * I3 canonical gallery order: (addedAt desc, memberKey asc, id asc). Pure —
 * no clock or environment — so the derived gallery is byte-identical on every
 * replica (issue #23, invariant I3). Single source of truth for both the raw
 * `Photo` comparator and the derived-entry comparator (bug #55).
 */
export function canonicalGalleryOrder(a: CanonicalOrderKey, b: CanonicalOrderKey): number {
  if (a.addedAt !== b.addedAt) return b.addedAt - a.addedAt;
  const byMember = a.memberKey < b.memberKey ? -1 : a.memberKey > b.memberKey ? 1 : 0;
  if (byMember !== 0) return byMember;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function compareGalleryOrder(a: Photo, b: Photo): number {
  return canonicalGalleryOrder(
    { addedAt: a.addedAt, memberKey: a.member.key, id: a.id },
    { addedAt: b.addedAt, memberKey: b.member.key, id: b.id },
  );
}

/** One drive's `/photos` listing as fed into the gallery derivation. */
export interface DriveScan {
  /** Hex key of the drive that owns these entries (tombstone scope). */
  key: string;
  /** Raw hyperdrive entries under `photos/` (key + value with metadata). */
  entries: Array<{ key: string; value: Record<string, unknown> }>;
}

/** A derived gallery entry before host effects (mounting, URL building). */
export interface DerivedPhoto {
  driveKey: string;
  id: string;
  ext: string;
  name: string;
  mime: string;
  size: number;
  addedAt: number;
  sha256?: string;
  /** Resolved display name for the owning member drive. */
  memberName: string;
}

const PHOTO_BASE_RE = /^(.*?)(\.[^/.]+)?$/;

/**
 * I1/I2/I4/I6 at the derivation layer (issue #23). Pure: same inputs give
 * the same output on every replica, independent of scan order or batching.
 *
 * - I1 identity: an entry is `driveKey:id` — the composite key tombstones
 *   and ordering use, unambiguous across members reusing local ids.
 * - I2/I4: a tombstone `driveKey:id` hides that entry whenever it exists —
 *   visibility-independent, sticky while the tombstone stands, inert for ids
 *   never seen again.
 * - I6: output depends only on the SET of scans — commutative over order,
 *   idempotent under duplicate scans, associative over batching; canonical
 *   order applied at the end.
 */
export function deriveGallery(
  scans: DriveScan[],
  removed: Record<string, unknown>,
  memberNameFor: (driveKey: string) => string,
): DerivedPhoto[] {
  // Idempotence + associativity: a drive may arrive as one scan or several
  // batches — entries are merged per drive key and deduped by entry path
  // (a later batch's value for the same path wins), never dropped.
  const byKey = new Map<string, Map<string, DriveScan["entries"][number]>>();
  for (const scan of scans) {
    let paths = byKey.get(scan.key);
    if (!paths) {
      paths = new Map();
      byKey.set(scan.key, paths);
    }
    for (const entry of scan.entries) paths.set(entry.key, entry);
  }
  const out: DerivedPhoto[] = [];
  for (const [key, paths] of byKey) {
    const memberName = memberNameFor(key);
    for (const entry of paths.values()) {
      // Production hyperdrive keys are absolute (`/photos/<id>.<ext>`). Strip a
      // leading slash before dropping the prefix so the derived id never carries
      // a spurious `/` — otherwise `remove()`'s key match (which uses the
      // slash-free `drivePhotoKeys`) fails for every photo (issue #50).
      const stripped = entry.key.startsWith("/") ? entry.key.slice(1) : entry.key;
      const base = stripped.slice("photos/".length);
      const extMatch = PHOTO_BASE_RE.exec(base);
      if (!extMatch) continue;
      const id = extMatch[1]!;
      const ext = extMatch[2] ?? "";
      const meta = (entry.value?.metadata ?? {}) as Record<string, unknown>;
      // I2/I4: tombstones apply over the registry snapshot, never gated on
      // this device having "seen" the photo first.
      if (removed[`${key}:${id}`]) continue;
      out.push({
        driveKey: key,
        id,
        ext,
        name: typeof meta.name === "string" ? meta.name : base,
        mime: typeof meta.mime === "string" ? meta.mime : guessMime(ext),
        size: typeof entry.value?.size === "number" ? entry.value.size : 0,
        addedAt: typeof meta.addedAt === "number" ? meta.addedAt : 0,
        ...(typeof meta.sha256 === "string" ? { sha256: meta.sha256 } : {}),
        memberName,
      });
    }
  }
  return out.sort(byDerivedOrder);
}

function byDerivedOrder(a: DerivedPhoto, b: DerivedPhoto): number {
  // Delegates to the I3 canonical order so production order matches the
  // documented spec (bug #55): deriveGallery's tie-break key is driveKey,
  // which is the same value compareGalleryOrder reads as member.key.
  return canonicalGalleryOrder(
    { addedAt: a.addedAt, memberKey: a.driveKey, id: a.id },
    { addedAt: b.addedAt, memberKey: b.driveKey, id: b.id },
  );
}

/** Mirrors photo-store's extension→mime table for the pure derivation
 * (case-insensitive: extensions come from drive paths, which keep their case). */
function guessMimeFor(extRaw: string): string {
  switch (extRaw.toLowerCase()) {
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".heic":
      return "image/heic";
    case ".mp4":
      return "video/mp4";
    case ".mov":
      return "video/quicktime";
    default:
      return "image/jpeg";
  }
}
