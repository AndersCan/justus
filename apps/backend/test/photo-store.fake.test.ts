/**
 * Drive-dependent scenario tests for `createPhotoStore`, built entirely on the
 * contract-checked fakes (`./fakes/fake-store-deps`). Each suite reproduces one of the
 * six sweep bugs (#42/#43/#46/#47/#49/#52) deterministically and asserts the
 * fixed behavior.
 *
 * This file is added incrementally: #46 lands here first; the remaining suites
 * follow as their fixes land.
 */
import { makeTmpDir } from "./tmp-dirs.ts";
import { describe, it, expect } from "vite-plus/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createPhotoStore } from "../src/photo-store.ts";
import { createFakeHub, type FakeNode } from "./fakes/fake-world.ts";
import { fakeStoreDeps, joinAsMember, restarted } from "./fakes/fake-store-deps.ts";
import type { DriveStore } from "../src/ports/drive-store.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A write by the drive's owner: fires the drive's change listeners, as a replicated update does. */
async function touch(drives: DriveStore, key: string): Promise<void> {
  const [err, drive] = await drives.open(key, { timeoutMs: 1_000 });
  if (err) throw err;
  await drive.put("/touch", new TextEncoder().encode(String(Date.now())));
  await drives.release(drive);
}

/** Photos stored under /photos/ in this node's copy of the drive. */
const photosOn = (node: FakeNode, key: string): number =>
  [...(node.replicas.get(key)?.files.keys() ?? [])].filter((p) => p.startsWith("/photos/")).length;

/** A store on the checked fakes. Drives named in `offline` do not become ready. */
function buildStore() {
  const offline = new Set<string>();
  const hub = createFakeHub({ unreachable: (key) => offline.has(key) });
  const changes: Array<{ folderId: string }> = [];
  const deps = fakeStoreDeps({
    hub,
    onChanged: (c) => changes.push({ folderId: c.folderId }),
  });
  const store = createPhotoStore(deps);
  // addBytes stages uploads into cacheDir, which the production runtime
  // pre-creates — mirror that here so staging doesn't throw.
  mkdirSync(deps.cacheDir, { recursive: true });
  return { store, deps, offline, changes };
}

// #46 originally silenced inactive folders. Every album now stays live so the
// Photos page can show all of them, so an inactive album must keep reporting.
describe("#46 switching albums keeps every album live", () => {
  it("keeps firing onChanged for an inactive folder's drive", async () => {
    const { store, deps, changes } = buildStore();
    await store.ready();

    const aRes = await store.createFolder("A");
    expect(aRes[0]).toBeNull();
    const bRes = await store.createFolder("B");
    expect(bRes[0]).toBeNull();

    const aId = (aRes[1] as { folder: { id: string; shareKey: string } }).folder.id;
    const bId = (bRes[1] as { folder: { id: string; shareKey: string } }).folder.id;
    const aKey = (aRes[1] as { folder: { shareKey: string } }).folder.shareKey;
    const bKey = (bRes[1] as { folder: { shareKey: string } }).folder.shareKey;
    await store.setActive(aId);

    // A is active and still watched → its updates reach onChanged.
    const beforeA = changes.length;
    await touch(deps.drives, aKey);
    await sleep(500);
    expect(changes.slice(beforeA).some((c) => c.folderId === aId)).toBe(true);

    // B is inactive but still live → replication to B reaches onChanged too.
    const beforeB = changes.length;
    await touch(deps.drives, bKey);
    await sleep(500);
    expect(changes.slice(beforeB).some((c) => c.folderId === bId)).toBe(true);

    await store.close();
  });
});

describe("#47 join must be idempotent for an already-joined share key", () => {
  it("does not mint a second FolderRecord on a repeat join", async () => {
    const { store } = buildStore();
    await store.ready();

    // A valid 64-char hex share key (not our own identity drive).
    const key = "0123456789abcdef".repeat(4);

    const first = await store.join(key);
    expect(first[0]).toBeNull();
    const firstCount = (await store.folders()).folders.length;

    // Re-joining the same key must be a no-op at the record level.
    const second = await store.join(key);
    expect(second[0]).toBeNull();
    const after = await store.folders();
    expect(after.folders.length).toBe(firstCount);

    // Exactly one folder carries that share key — no duplicate FolderRecord.
    const joined = after.folders.filter((f) => f.shareKey === key);
    expect(joined.length).toBe(1);

    await store.close();
  });
});

describe("#42 a creator folder must stay a creator after a restart", () => {
  it("keeps the 2nd creator folder as creator and addable after re-createPhotoStore", async () => {
    // Share one on-disk storageDir so the persisted folder records survive the
    // "restart" (a second createPhotoStore against the same dir).
    const storageDir = makeTmpDir("justus-42-");
    const cacheDir = join(storageDir, "cache");
    // The harness doesn't pre-create the cache dir; addBytes stages uploads into
    // it, so create it the way the production runtime does.
    mkdirSync(cacheDir, { recursive: true });

    // Session 1: build the device, add a 2nd creator folder, add a photo.
    const first = fakeStoreDeps({ storageDir, cacheDir, seedOnEmpty: false });
    const store1 = createPhotoStore(first);
    await store1.ready();
    const created = await store1.createFolder("Holidays");
    expect(created[0]).toBeNull();
    const holidayId = created[1]!.folder.id;
    expect(created[1]!.folder.role).toBe("creator");

    const add1 = await store1.addBytes("beach.jpg", new Uint8Array([1, 2, 3, 4]));
    expect(add1[0]).toBeNull();
    await store1.close();

    // Session 2: simulate a restart — same storageDir, fresh in-memory drives.
    const store2 = createPhotoStore(restarted(first));
    await store2.ready();

    const after = await store2.folders();
    const holidays = after.folders.find((f) => f.id === holidayId);
    expect(holidays).toBeDefined();
    // The bug: a 2nd+ creator folder recomputed its role from the live registry
    // (which doesn't list the creator) and downgraded to "reader".
    expect(holidays!.role).toBe("creator");

    // Being a creator, add must still succeed in the restarted session.
    await store2.setActive(holidayId);
    const add2 = await store2.addBytes("sunset.jpg", new Uint8Array([5, 6, 7, 8]));
    expect(add2[0]).toBeNull();

    await store2.close();
  });
});

/**
 * Builds N stores on one hub, so a drive opened by key is the same replicated
 * drive across every store (modelling p2p replication). This is what lets us
 * drive genuine multi-device scenarios (#43/#49/#52) where a member's drive
 * contents are visible to another member's store.
 */
function buildDevices(names: string[]) {
  const hub = createFakeHub();
  const devices = names.map((name) => {
    const changes: Array<{ folderId: string }> = [];
    const deps = fakeStoreDeps({
      hub,
      deviceName: name,
      onChanged: (c) => changes.push({ folderId: c.folderId }),
    });
    // addBytes stages uploads into cacheDir, which the production runtime
    // pre-creates — mirror that here so staging doesn't throw.
    mkdirSync(deps.cacheDir, { recursive: true });
    const store = createPhotoStore(deps);
    return { store, changes, deps };
  });
  return { devices };
}

describe("#49 a member re-adding another member's bytes must own its own copy", () => {
  it("writes a local copy instead of adopting the foreign entry", async () => {
    const { devices } = buildDevices(["Creator", "Alice", "Bob"]);
    const [creator, alice, bob] = devices;

    // Bring every device up so each has its (random) identity drive.
    await creator.store.ready();
    await alice.store.ready();
    await bob.store.ready();

    // Creator makes a folder and enrols both members.
    const created = await creator.store.createFolder("Family");
    expect(created[0]).toBeNull();
    const folderId = created[1]!.folder.id;
    const folderKey = created[1]!.folder.shareKey;
    const aliceKey = await joinAsMember(creator.store, folderId, alice.store, folderKey);
    const bobKey = await joinAsMember(creator.store, folderId, bob.store, folderKey);

    const aliceFamily = (await alice.store.folders()).folders.find(
      (f) => f.shareKey === folderKey,
    )!;
    expect(aliceFamily.role).toBe("member");
    const bobFamily = (await bob.store.folders()).folders.find((f) => f.shareKey === folderKey)!;
    expect(bobFamily.role).toBe("member");

    const photo = new Uint8Array([1, 2, 3, 4, 5]);

    // Alice adds the photo — it lives on Alice's own drive.
    await alice.store.setActive(aliceFamily.id);
    const aRes = await alice.store.addBytes("alice.jpg", photo);
    expect(aRes[0]).toBeNull();
    const aPhoto = aRes[1];
    expect(aPhoto.member.key).toBe(aliceKey);

    // Bob re-adds the SAME bytes. Before the fix this adopted Alice's entry
    // (member.key === aliceKey) and was unremovable for Bob; after the fix Bob
    // owns his own copy on his own drive.
    await bob.store.setActive(bobFamily.id);
    const bRes = await bob.store.addBytes("bob.jpg", photo);
    expect(bRes[0]).toBeNull();
    const bPhoto = bRes[1];
    expect(bPhoto.member.key).toBe(bobKey);

    // Because the copy is on Bob's own drive, Bob can remove it.
    const rm = await bob.store.remove(bPhoto.id);
    expect(rm[0]).toBeNull();

    await creator.store.close();
    await alice.store.close();
    await bob.store.close();
  });
});

describe("#52 an approved join must upgrade reader → member in-session", () => {
  it("flips a pending reader to member and lets them add after approval", async () => {
    const { devices } = buildDevices(["Creator", "Bob"]);
    const [creator, bob] = devices;

    await creator.store.ready();
    await bob.store.ready();

    const created = await creator.store.createFolder("Trip");
    expect(created[0]).toBeNull();
    const folderId = created[1]!.folder.id;
    const folderKey = created[1]!.folder.shareKey;

    // Bob joins before being approved → pending reader (can read, cannot add).
    const bj = await bob.store.join(folderKey);
    expect(bj[0]).toBeNull();
    const bobFolder = (await bob.store.folders()).folders.find((f) => f.shareKey === folderKey)!;
    expect(bobFolder.role).toBe("reader");
    expect(bobFolder.pending).toBe(true);
    // Bob asked with his drive for this album, not his identity drive (#195).
    const bobKey = bobFolder.driveKey;
    expect(bobKey).not.toBe((await bob.deps.drives.openOwn()).key);

    // An unapproved reader cannot add photos.
    const earlyAdd = await bob.store.addBytes("early.jpg", new Uint8Array([1, 2, 3]));
    expect(earlyAdd[0]).not.toBeNull();

    // Creator approves. respond() writes the membership into the folder drive,
    // which replicates to Bob's watched drive and triggers the in-session
    // reader → member upgrade (no restart required).
    const resp = await creator.store.respond(folderId, bobKey, true);
    expect(resp[0]).toBeNull();

    // Let the debounced drive "update" handler re-derive Bob's role.
    await sleep(600);

    const after = (await bob.store.folders()).folders.find((f) => f.shareKey === folderKey)!;
    expect(after.role).toBe("member");
    expect(after.pending).toBe(false);

    // The upgraded member can now add photos in-session.
    const add = await bob.store.addBytes("bob.jpg", new Uint8Array([4, 5, 6, 7]));
    expect(add[0]).toBeNull();
    expect(add[1].member.key).toBe(bobKey);

    await creator.store.close();
    await bob.store.close();
  });
});

describe("#43 content dedupe must survive an unreachable drive", () => {
  it("does not write a duplicate when the owner's drive is briefly offline", async () => {
    const { store, deps, offline } = buildStore();
    await store.ready();
    await store.createFolder("Mine");

    const photo = new Uint8Array([9, 8, 7, 6, 5, 4]);

    // First add writes the photo and seeds the content index.
    const r1 = await store.addBytes("mine.jpg", photo);
    expect(r1[0]).toBeNull();
    const firstId = r1[1].id;

    // Simulate this device's own drive going unreachable right before a re-add
    // (a flaky peer / not-yet-replicated block). A live full-gallery scan would
    // now skip it and miss the existing copy.
    const ownKey = (await store.status()).folder.shareKey;
    offline.add(ownKey);

    // Re-adding the same bytes must dedupe in-session via the content index,
    // returning the SAME entry rather than writing a second copy.
    const r2 = await store.addBytes("mine.jpg", photo);
    expect(r2[0]).toBeNull();
    expect(r2[1].id).toBe(firstId);

    // No second photo was written to the drive.
    expect(photosOn(deps.node, ownKey)).toBe(1);

    // After the drive recovers, the original is still there and dedupes.
    offline.delete(ownKey);
    const r3 = await store.addBytes("mine.jpg", photo);
    expect(r3[0]).toBeNull();
    expect(r3[1].id).toBe(firstId);
    expect(photosOn(deps.node, ownKey)).toBe(1);

    await store.close();
  });

  describe("#76 setActive must re-arm the incoming folder's watcher after a round-trip", () => {
    it("keeps firing onChanged for A after A->B->A", async () => {
      const { store, deps, changes } = buildStore();
      await store.ready();
      const aRes = await store.createFolder("A");
      expect(aRes[0]).toBeNull();
      const bRes = await store.createFolder("B");
      expect(bRes[0]).toBeNull();
      const aId = (aRes[1] as { folder: { id: string; shareKey: string } }).folder.id;
      const bId = (bRes[1] as { folder: { id: string; shareKey: string } }).folder.id;
      const aKey = (aRes[1] as { folder: { shareKey: string } }).folder.shareKey;
      const bKey = (bRes[1] as { folder: { shareKey: string } }).folder.shareKey;
      await store.setActive(aId);
      await store.setActive(bId);
      await store.setActive(aId);
      const beforeA = changes.length;
      await touch(deps.drives, aKey);
      await sleep(500);
      expect(changes.slice(beforeA).some((c) => c.folderId === aId)).toBe(true);
      const beforeB = changes.length;
      await touch(deps.drives, bKey);
      await sleep(500);
      expect(changes.slice(beforeB).filter((c) => c.folderId === bId)).toHaveLength(1);
      await store.close();
    });
  });
});

describe("#89 folder/status member metadata must be consistent across roles", () => {
  it("reader reports a real member count; member and reader lists include self", async () => {
    const { devices } = buildDevices(["Creator", "Alice", "Bob", "Reader"]);
    const [creator, alice, bob, reader] = devices;
    await creator.store.ready();
    await alice.store.ready();
    await bob.store.ready();
    await reader.store.ready();

    const created = await creator.store.createFolder("Fam");
    expect(created[0]).toBeNull();
    const folderId = created[1]!.folder.id;
    const folderKey = created[1]!.folder.shareKey;

    // Creator enrols Alice and Bob; Reader stays a pending reader.
    const aliceKey = await joinAsMember(creator.store, folderId, alice.store, folderKey);
    await joinAsMember(creator.store, folderId, bob.store, folderKey);
    expect((await reader.store.join(folderKey))[0]).toBeNull();
    const readerKey = (await reader.store.folders()).folders.find(
      (f) => f.shareKey === folderKey,
    )!.driveKey;

    // Let the folder's watch handlers settle their async member-drive refreshes
    // (the same microtask gap #52 waits out) before asserting on derived counts.
    await sleep(600);

    // Alice (member): status().members must include her own device key.
    const aliceFam = (await alice.store.folders()).folders.find((f) => f.shareKey === folderKey)!;
    await alice.store.setActive(aliceFam.id);
    const aliceStatus = await alice.store.status();
    expect(aliceStatus.members.map((m: { key: string }) => m.key)).toContain(aliceKey);

    // Reader: member count must be derived from the opened member drives, not
    // hard-coded to 0, and its status list must include itself.
    const readerFam = (await reader.store.folders()).folders.find((f) => f.shareKey === folderKey)!;
    expect(readerFam.members).toBeGreaterThan(0);
    await reader.store.setActive(readerFam.id);
    const readerStatus = await reader.store.status();
    expect(readerStatus.members.map((m: { key: string }) => m.key)).toContain(readerKey);

    await Promise.all(devices.map((d) => d.store.close()));
  });
});

describe("#86/#91/#96 setActive must re-arm member-drive watchers after a round-trip", () => {
  it("keeps firing onChanged for a peer's drive after Family -> Trips -> Family", async () => {
    const { devices } = buildDevices(["Creator", "Alice", "Bob"]);
    const [creator, alice, bob] = devices;
    await creator.store.ready();
    await alice.store.ready();
    await bob.store.ready();

    // Creator makes a folder and enrols Bob + Alice. Alice joins as a member,
    // so her Family runtime opens Bob's drive into `rt.memberDrives` and arms a
    // watcher on it (issue #89 path). The fake shares drives by key, so the
    // drive Alice watches is Bob's own, which Bob's deps write below.
    const created = await creator.store.createFolder("Family");
    expect(created[0]).toBeNull();
    const folderId = created[1]!.folder.id;
    const folderKey = created[1]!.folder.shareKey;
    const bobKey = await joinAsMember(creator.store, folderId, bob.store, folderKey);
    await joinAsMember(creator.store, folderId, alice.store, folderKey);
    const aliceFamily = (await alice.store.folders()).folders.find(
      (f) => f.shareKey === folderKey,
    )!;
    expect(aliceFamily.role).toBe("member");

    // A second folder to switch away to (so Family becomes the "previous active"
    // and gets unmounted — which clears Family's `memberDrives`).
    const trips = await alice.store.createFolder("Trips");
    expect(trips[0]).toBeNull();
    const tripsId = trips[1]!.folder.id;

    // Let the async member-drive refresh (Bob's drive open) settle.
    await sleep(600);

    // Round-trip: activate Family, switch to Trips (unmounts Family, dropping
    // its member-drive watchers), then re-activate Family.
    await alice.store.setActive(aliceFamily.id);
    await alice.store.setActive(tripsId);
    await alice.store.setActive(aliceFamily.id);

    // The re-activation must have re-opened Bob's drive and re-armed its watcher.
    await sleep(600);
    const before = alice.changes.length;
    await touch(bob.deps.drives, bobKey);
    await sleep(600);

    // Replication from Bob's drive must still reach the gallery for Family.
    expect(alice.changes.slice(before).some((c) => c.folderId === aliceFamily.id)).toBe(true);

    await Promise.all(devices.map((d) => d.store.close()));
  });
});

describe("createFolder gives each new album a drive of its own", () => {
  it("never reuses the device's own drive or another album's", async () => {
    const deps = fakeStoreDeps();
    mkdirSync(deps.cacheDir, { recursive: true });
    const store = createPhotoStore(deps);
    await store.ready();
    const { folders: before } = await store.folders();

    const a = await store.createFolder("A");
    const b = await store.createFolder("B");
    expect(a[0]).toBeNull();
    expect(b[0]).toBeNull();
    const keys = [
      ...before.map((f) => f.shareKey),
      (a[1] as { folder: { shareKey: string } }).folder.shareKey,
      (b[1] as { folder: { shareKey: string } }).folder.shareKey,
    ];
    expect(new Set(keys).size).toBe(keys.length);

    await store.close();
  });
});
