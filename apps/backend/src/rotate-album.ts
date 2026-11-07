/**
 * Copies an album's own photos onto its new drive (key rotation, saved state
 * 1 → 2). Delete this file and `migrateFromV1` in photo-store.ts once no
 * version 1 state is left to open.
 */

/** Any drive handle (the p2p packages ship no types). */
type Drive = any;

const COPIED_DIRS = ["/photos", "/thumbs"];

async function sizeAt(drive: Drive, path: string): Promise<number | null> {
  const node = await drive.entry(path);
  const size = node?.value?.blob?.byteLength;
  return typeof size === "number" ? size : null;
}

async function listPaths(drive: Drive, dir: string): Promise<string[]> {
  const out: string[] = [];
  for await (const entry of drive.list(dir)) out.push((entry as { key: string }).key);
  return out;
}

export async function copyAlbumEntries(
  from: Drive,
  to: Drive,
): Promise<{ photos: number; thumbs: number }> {
  const counts = { photos: 0, thumbs: 0 };
  for (const dir of COPIED_DIRS) {
    for (const path of await listPaths(from, dir)) {
      const node = await from.entry(path);
      const bytes = await from.get(path);
      if (!node || !bytes) throw new Error(`rotate: cannot read ${path}`);
      const have = await sizeAt(to, path);
      if (have !== bytes.byteLength) {
        const metadata = node.value?.metadata;
        await to.put(path, bytes, metadata === undefined ? undefined : { metadata });
      }
      if (dir === "/photos") counts.photos++;
      else counts.thumbs++;
    }
  }
  const missing: string[] = [];
  for (const path of await listPaths(from, "/photos")) {
    const a = await from.entry(path);
    const b = await to.entry(path);
    const sameSize = a?.value?.blob?.byteLength === b?.value?.blob?.byteLength;
    const wantHash = a?.value?.metadata?.sha256;
    const sameHash = wantHash === undefined || b?.value?.metadata?.sha256 === wantHash;
    if (!b || !sameSize || !sameHash) missing.push(path);
  }
  if (missing.length > 0) {
    throw new Error(`rotate: copy incomplete ${missing.length} of ${counts.photos}`);
  }
  return counts;
}
