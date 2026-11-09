/**
 * Copies an album's own photos onto its new drive (key rotation, saved state
 * 1 → 2). Delete this file and `migrateFromV1` in photo-store.ts once no
 * version 1 state is left to open.
 */
import type { Drive, DriveEntry } from "./ports/drive-store";

const COPIED_DIRS = ["/photos", "/thumbs"];

async function entriesIn(drive: Drive, dir: string): Promise<Map<string, DriveEntry>> {
  const out = new Map<string, DriveEntry>();
  for await (const entry of drive.list(dir)) out.set(entry.path, entry);
  return out;
}

export async function copyAlbumEntries(
  from: Drive,
  to: Drive,
): Promise<{ photos: number; thumbs: number }> {
  const counts = { photos: 0, thumbs: 0 };
  for (const dir of COPIED_DIRS) {
    const have = await entriesIn(to, dir);
    for (const entry of (await entriesIn(from, dir)).values()) {
      const bytes = await from.readBytes(entry.path);
      if (!bytes) throw new Error(`rotate: cannot read ${entry.path}`);
      if (have.get(entry.path)?.size !== bytes.byteLength) {
        await to.put(entry.path, bytes, { metadata: entry.metadata });
      }
      if (dir === "/photos") counts.photos++;
      else counts.thumbs++;
    }
  }
  const copied = await entriesIn(to, "/photos");
  const missing: string[] = [];
  for (const a of (await entriesIn(from, "/photos")).values()) {
    const b = copied.get(a.path);
    const wantHash = a.metadata.sha256;
    const sameHash = wantHash === undefined || b?.metadata.sha256 === wantHash;
    if (!b || b.size !== a.size || !sameHash) missing.push(a.path);
  }
  if (missing.length > 0) {
    throw new Error(`rotate: copy incomplete ${missing.length} of ${counts.photos}`);
  }
  return counts;
}

const DEVICE = "/device.json";
const FOLDER = "/folder.json";
const REQUESTS = "/requests.json";

/**
 * The identity drive held a pre-#195 album: delete every file but /device.json
 * and the phone's own /requests.json outbox, then keep only /device.json so no
 * older version of the drive gives back a photo or a member list, and put the
 * outbox back after. Does nothing when /folder.json is absent.
 */
export async function clearOldAlbumOffIdentity(
  identity: Drive,
): Promise<[Error, null] | [null, "nothing" | "cleared"]> {
  try {
    const paths = [...(await entriesIn(identity, "/")).keys()];
    if (!paths.includes(FOLDER)) return [null, "nothing"];
    const device = await identity.readBytes(DEVICE);
    if (!device) return [new Error("clear: cannot read /device.json"), null];
    const requests = paths.includes(REQUESTS) ? await identity.readBytes(REQUESTS) : undefined;
    for (const path of paths) {
      if (path !== DEVICE) await identity.del(path);
    }
    await identity.put(DEVICE, device);
    const [keepErr, kept] = await identity.keepOnly(DEVICE);
    if (keepErr) return [keepErr, null];
    if (!kept.olderVersionsCleared) {
      return [new Error("clear: older versions of the identity drive remain"), null];
    }
    if (requests) await identity.put(REQUESTS, requests);
    return [null, "cleared"];
  } catch (e) {
    return [e instanceof Error ? e : new Error(String(e)), null];
  }
}
