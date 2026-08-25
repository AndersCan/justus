/**
 * Integration lane for issue #23 — convergence invariants (I1/I3/I5/I6)
 * pinned through the REAL seam, not the fork model in
 * `../src/gallery-convergence.test.ts`.
 *
 * The fork harness re-implements sync mechanics on top of `deriveGallery` so it
 * can run with no Bare runtime. This file drives the actual `createPhotoStore`
 * API (`addBytes` -> drive -> `list` -> `deriveGallery`) across two real devices
 * that share one in-memory drive registry (the `FakeDrive` harness), so the
 * invariants are proven against the production code path — including the
 * #19/#82 metadata threading (real `sha256`) and the #20/#43 content dedupe
 * that only exist at the `add` layer.
 *
 * Runs under vitest with no Bare runtime or live p2p: `FakeDrive` instances are
 * cached by key across both stores, so a photo one device writes is visible to
 * the other the moment `list()` re-scans the shared in-memory drive. The CI
 * expansion of this lane (real Bare two-peer replication) is a guarded
 * superset; this in-sandbox slice pins the seam logic itself.
 */
import { describe, expect, it } from "vite-plus/test";
import { createHash } from "node:crypto";
import { createPhotoStore } from "../src/photo-store.ts";
import { canonicalGalleryOrder, type CanonicalOrderKey } from "../src/gallery-order.ts";
import { makeFakeDeps, FakeDrive } from "./fake-drive.ts";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const hexKey = (b: Buffer): string => b.toString("hex");
const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(Buffer.from(bytes)).digest("hex");

/** Build N real stores that share ONE drive registry (modelling p2p), so a
 * drive opened by key resolves to the same `FakeDrive` across every store. */
function buildDevices(names: string[]) {
  const cache = new Map<string, FakeDrive>();
  const meta = names.map(() => ({ ownDrive: null as FakeDrive | null }));
  let devSeed = 0;
  const makeDriveFor = (i: number) => {
    let firstNoKey = true;
    return (_cs: unknown, key?: Buffer): FakeDrive => {
      const seed = key ? key.toString("hex") : `seed-${i}-${devSeed++}`;
      const drive = new FakeDrive(seed);
      const id = drive.key.toString("hex");
      let cached = cache.get(id);
      if (!cached) {
        cache.set(id, drive);
        cached = drive;
      }
      if (!key && firstNoKey) {
        firstNoKey = false;
        meta[i].ownDrive = cached;
      }
      return cached;
    };
  };
  const devices = names.map((name, i) => {
    const deps = makeFakeDeps({
      deviceName: name,
      makeDrive: makeDriveFor(i),
    });
    mkdirSync(deps.cacheDir, { recursive: true });
    const store = createPhotoStore(deps);
    return { store, deps, ownDrive: () => meta[i].ownDrive! };
  });
  return { devices, cache };
}

const bytes = (arr: number[]): Uint8Array => new Uint8Array(arr);

/** Normalize a listed gallery to a stable key string for convergence compares. */
function norm(p: {
  member: { key: string };
  id: string;
  addedAt: number;
  sha256?: string;
}): string {
  return `${p.member.key}:${p.id}:${p.addedAt}:${p.sha256 ?? ""}`;
}

describe("#23 integration lane — two devices converge through the real seam", () => {
  it("pins I1/I3/I5/I6 across a creator + member sharing one folder", async () => {
    const { devices } = buildDevices(["Creator", "Member"]);
    const [creator, member] = devices;

    await creator.store.ready();
    await member.store.ready();
    const memberKey = hexKey(member.ownDrive().key);

    // Creator makes a folder and pre-enrols the member (no p2p in the fake).
    const created = await creator.store.createFolder("Trip");
    expect(created[0]).toBeNull();
    const folderId = created[1]!.folder.id;
    const folderKey = created[1]!.folder.shareKey;
    await creator.store.respond(folderId, memberKey, true);

    const mj = await member.store.join(folderKey);
    expect(mj[0]).toBeNull();
    const memberFolder = (await member.store.folders()).folders.find(
      (f) => f.shareKey === folderKey,
    )!;
    expect(memberFolder.role).toBe("member");

    // Distinctive contents so cross-test module state cannot collide.
    const CREATOR_DUP = bytes([201, 2, 3]); // added twice by creator -> 1 entry (I5)
    const CREATOR_ONLY = bytes([204, 5, 6]);
    const MEMBER_ONLY = bytes([207, 8, 9]);
    const MEMBER_DUP = bytes([201, 2, 3]); // same bytes as creator -> kept (distinct owner)

    // Creator writes its photos (folder drive).
    await creator.store.setActive(folderId);
    await creator.store.addBytes("c1.jpg", CREATOR_DUP);
    await creator.store.addBytes("c2.jpg", CREATOR_DUP); // deduped onto c1
    await creator.store.addBytes("c3.jpg", CREATOR_ONLY);

    // Member writes its photos (own drive).
    await member.store.setActive(memberFolder.id);
    await member.store.addBytes("m1.jpg", MEMBER_ONLY);
    await member.store.addBytes("m2.jpg", MEMBER_DUP); // own copy, distinct from creator's

    const ga = await creator.store.list();
    const gb = await member.store.list();

    // I6 — convergence: both devices derive the same gallery (same set AND
    // same canonical order), equal to the shared ground truth.
    const keysA = ga.map(norm);
    const keysB = gb.map(norm);
    expect(keysA).toEqual(keysB);
    // Exactly four photos: creator(c1, c3) + member(m1, m2). c2 deduped, m2 kept.
    expect(ga).toHaveLength(4);

    // I1 — composite identity: `ownerKey:id` is unique across the gallery.
    const composite = ga.map((p) => `${p.member.key}:${p.id}`);
    expect(new Set(composite).size).toBe(composite.length);

    // I3 — canonical order is a pure function of record data: re-sorting by the
    // canonical key is a no-op (the gallery is already canonically ordered).
    const toKey = (p: {
      addedAt: number;
      member: { key: string };
      id: string;
    }): CanonicalOrderKey => ({
      addedAt: p.addedAt,
      memberKey: p.member.key,
      id: p.id,
    });
    const resorted = [...ga].sort((a, b) => canonicalGalleryOrder(toKey(a), toKey(b)));
    expect(ga.map(norm)).toEqual(resorted.map(norm));

    // I5 — per-owner sha256 uniqueness: no owner contributes two entries that
    // share a digest. Also: the creator's duplicate-content add collapsed to a
    // single entry, while the member's same-content add is a distinct owner's
    // copy (not adopted from the creator).
    const byOwner = new Map<string, Set<string>>();
    for (const p of ga) {
      if (!p.sha256) continue;
      const seen = byOwner.get(p.member.key) ?? new Set<string>();
      expect(seen.has(p.sha256)).toBe(false);
      seen.add(p.sha256);
      byOwner.set(p.member.key, seen);
    }
    const creatorPhotos = ga.filter((p) => p.member.key === folderKey);
    const memberPhotos = ga.filter((p) => p.member.key === memberKey);
    expect(creatorPhotos.filter((p) => p.sha256 === sha256(CREATOR_DUP))).toHaveLength(1);
    expect(memberPhotos.filter((p) => p.sha256 === sha256(MEMBER_DUP))).toHaveLength(1);

    await creator.store.close();
    await member.store.close();
  });

  it("is deterministic: a second list() yields an identical gallery", async () => {
    const { devices } = buildDevices(["Solo"]);
    const [solo] = devices;
    await solo.store.ready();

    const created = await solo.store.createFolder("Solo");
    const folderId = created[1]!.folder.id;
    await solo.store.setActive(folderId);
    await solo.store.addBytes("s1.jpg", bytes([11, 12, 13]));
    await solo.store.addBytes("s2.jpg", bytes([14, 15, 16]));
    await solo.store.addBytes("s1.jpg", bytes([11, 12, 13])); // deduped

    const first = await solo.store.list();
    const second = await solo.store.list();
    expect(first.map(norm)).toEqual(second.map(norm));
    expect(first).toHaveLength(2);

    await solo.store.close();
  });
});
