/**
 * Adding a photo to this device's drive in an album, and reading the album's
 * gallery off its members' drives, over the drive port. photo-store keeps the
 * session state and serves the photos.
 */
import type { Drive } from "../ports/drive-store";
import { RENDITION_EXT, type Role } from "@justus/core";
import { deriveGallery, type DerivedPhoto, type DriveScan } from "../gallery-order";
import { parseDeviceName, parseRemoved } from "../membership/records";

export const DRIVE_PATH_PHOTOS = "/photos";
/** Thumbnails, one per photo, at `/thumbs/<id>.jpg`. Kept out of `/photos` so
 * the gallery derivation never mistakes one for a photo. */
export const DRIVE_PATH_THUMBS = "/thumbs";
export const DRIVE_PATH_REMOVED = "/removed.json";
const DRIVE_PATH_DEVICE = "/device.json";
/** Same cap as membership/join's MAX_PEER_JSON_BYTES: peers control these bytes. */
const MAX_RECORD_BYTES = 1024 * 1024;

export type GalleryLog = (
  event: string,
  fields?: Record<string, string | number | boolean | undefined>,
) => void;

/** The drives an album holds on this device. */
export type AlbumDrives = {
  role: Role;
  /** The Admin's share drive. */
  folderDrive: Drive;
  /** The drive this device writes to in the album (the folder drive for the Admin). */
  selfDrive: Drive;
  /** Other members' drives, opened read-only, by key. */
  memberDrives: ReadonlyMap<string, Drive>;
};

export type GallerySource = { key: string; drive: Drive };

export type PhotoMeta = {
  addedAt: number;
  name: string;
  mime: string;
  sha256?: string;
  takenAt?: string;
  /** The photo has a thumbnail at `/thumbs/<id>.jpg`; unset for photos added
   * before thumbnails existed. */
  thumb?: true;
};

export type NewPhoto = {
  id: string;
  /** Lowercased, with the dot, or "". */
  ext: string;
  bytes: Uint8Array;
  /** A JPEG thumbnail, written first at /thumbs/<id>.jpg. */
  thumb?: Uint8Array;
  name: string;
  mime: string;
  sha256: string;
  takenAt?: string;
};

export type AddedPhoto = Omit<DerivedPhoto, "memberName">;

export type GalleryError = { kind: "write-failed"; message: string };
/** The repo's error tuple (ADR 0002 decision 8). */
export type GalleryResult<T> = [GalleryError, null] | [null, T];

function short(hex: string): string {
  return hex.slice(0, 8);
}

function errText(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}

async function readText(
  drive: Drive,
  options: { path: string; log: GalleryLog },
): Promise<string | null> {
  const { path, log } = options;
  try {
    return (await drive.readSmall(path, MAX_RECORD_BYTES)) ?? null;
  } catch (thrown: unknown) {
    log("error", { where: "drive.read", drive: short(drive.key), path, err: errText(thrown) });
    return null;
  }
}

/**
 * The drives whose `/photos` make up the gallery for this device's role:
 * the Admin's drive first, then this device's own, then the other members'.
 */
export function galleryDrives(album: AlbumDrives): GallerySource[] {
  const { role, folderDrive, selfDrive, memberDrives } = album;
  const creatorKey = folderDrive.key;
  const sources: GallerySource[] = [];
  const seen = new Set<string>();
  function add(source: GallerySource) {
    if (seen.has(source.key)) return;
    seen.add(source.key);
    if (source.key === creatorKey) sources.unshift(source);
    else sources.push(source);
  }
  if (role === "creator" || role === "member") add({ key: selfDrive.key, drive: selfDrive });
  if (role === "reader" || role === "member") add({ key: creatorKey, drive: folderDrive });
  for (const [key, drive] of memberDrives) add({ key, drive });
  return sources;
}

/** Reads the album's gallery off its drives. A drive it cannot list is logged and skipped. */
export async function listGallery(
  sources: GallerySource[],
  options: {
    removedFrom: Drive;
    memberName: (key: string) => string | undefined;
    log: GalleryLog;
  },
): Promise<DerivedPhoto[]> {
  const { removedFrom, memberName, log } = options;
  const removed = parseRemoved(await readText(removedFrom, { path: DRIVE_PATH_REMOVED, log }));

  const scans: DriveScan[] = [];
  for (const { key, drive } of sources) {
    try {
      const entries = [];
      for await (const entry of drive.list(DRIVE_PATH_PHOTOS)) entries.push(entry);
      scans.push({ key, entries });
    } catch (e: unknown) {
      log("error", { where: "drive.scan", drive: short(key), err: errText(e) });
    }
  }

  // Sequential on purpose: same order of drive reads as before the move.
  const names = new Map<string, string>();
  for (const { key, drive } of sources) {
    names.set(
      key,
      memberName(key) ?? parseDeviceName(await readText(drive, { path: DRIVE_PATH_DEVICE, log })),
    );
  }
  return deriveGallery(scans, removed, (k) => names.get(k) ?? "Unknown device");
}

/** Writes one photo, and its thumbnail first, to this device's drive. */
export async function addPhoto(drive: Drive, photo: NewPhoto): Promise<GalleryResult<AddedPhoto>> {
  const { id, ext, bytes, thumb, name, mime, sha256, takenAt } = photo;
  const addedAt = Date.now();
  const metadata: PhotoMeta = {
    addedAt,
    name,
    mime,
    sha256,
    ...(takenAt ? { takenAt } : {}),
    ...(thumb ? { thumb: true as const } : {}),
  };
  try {
    // The thumbnail goes first, so a peer that sees the photo can show it.
    if (thumb) await drive.put(`${DRIVE_PATH_THUMBS}/${id}${RENDITION_EXT}`, thumb);
    await drive.put(`${DRIVE_PATH_PHOTOS}/${id}${ext}`, bytes, { metadata });
  } catch (e: unknown) {
    return [{ kind: "write-failed", message: errText(e) }, null];
  }
  return [
    null,
    {
      driveKey: drive.key,
      id,
      ext,
      name,
      mime,
      size: bytes.length,
      addedAt,
      sha256,
      ...(takenAt ? { takenAt } : {}),
      ...(thumb ? { hasThumb: true as const } : {}),
    },
  ];
}
