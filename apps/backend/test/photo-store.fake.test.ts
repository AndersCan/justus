/**
 * Drive-dependent scenario tests for `createPhotoStore`, built entirely on the
 * in-memory substitutes from `./fake-drive` (see
 * docs/design/fake-drive-test-harness-spec.md). Each suite reproduces one of the
 * six sweep bugs (#42/#43/#46/#47/#49/#52) deterministically and asserts the
 * fixed behavior.
 *
 * This file is added incrementally: #46 lands here first; the remaining suites
 * follow as their fixes land.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPhotoStore, type PhotoStore } from "../src/photo-store";
import { FakeDrive, makeFakeDeps } from "./fake-drive";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Build a store whose p2p constructs are in-memory, capturing the fake drives
 * it creates so tests can fire replication updates on a specific folder. */
function buildStore() {
  const drives: FakeDrive[] = [];
  const changes: Array<{ folderId: string }> = [];
  const deps = makeFakeDeps({
    onChanged: (c) => changes.push({ folderId: c.folderId }),
    makeDrive: (_cs: unknown, key?: Buffer) => {
      const drive = new FakeDrive(key ? key.toString("hex") : `seed-${drives.length}`);
      drives.push(drive);
      return drive;
    },
  });
  const store = createPhotoStore(deps);
  // addBytes stages uploads into cacheDir, which the production runtime
  // pre-creates — mirror that here so staging doesn't throw.
  mkdirSync(deps.cacheDir, { recursive: true });
  return { store, drives, changes };
}

function driveFor(drives: FakeDrive[], shareKey: string): FakeDrive {
  const found = drives.find((d) => d.key.toString("hex") === shareKey);
  if (!found) throw new Error(`no fake drive for shareKey ${shareKey}`);
  return found;
}

describe("#46 setActive must drop the previous folder's update watcher", () => {
  it("stops firing onChanged for an inactive folder's drive", async () => {
    const { store, drives, changes } = buildStore();
    await store.ready();

    const aRes = await store.createFolder("A");
    expect(aRes[0]).toBeNull();
    const bRes = await store.createFolder("B");
    expect(bRes[0]).toBeNull();

    const aId = (aRes[1] as { folder: { id: string; shareKey: string } }).folder.id;
    const bId = (bRes[1] as { folder: { id: string; shareKey: string } }).folder.id;
    const aKey = (aRes[1] as { folder: { shareKey: string } }).folder.shareKey;
    const bKey = (bRes[1] as { folder: { shareKey: string } }).folder.shareKey;
    const aDrive = driveFor(drives, aKey);
    const bDrive = driveFor(drives, bKey);

    // Make A active again: setActive unmounts the previously-active (B) folder,
    // which must remove B's `drive.on("update")` watcher.
    await store.setActive(aId);

    // A is active and still watched → its updates reach onChanged.
    const beforeA = changes.length;
    aDrive.emitUpdate();
    await sleep(500);
    expect(changes.slice(beforeA).some((c) => c.folderId === aId)).toBe(true);

    // B is inactive → replication to B's drive must NOT fire onChanged for B.
    const beforeB = changes.length;
    bDrive.emitUpdate();
    await sleep(500);
    expect(changes.slice(beforeB).some((c) => c.folderId === bId)).toBe(false);

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
    const storageDir = mkdtempSync(join(tmpdir(), "justus-42-"));
    const cacheDir = join(storageDir, "cache");
    // The harness doesn't pre-create the cache dir; addBytes stages uploads into
    // it, so create it the way the production runtime does.
    mkdirSync(cacheDir, { recursive: true });

    // Session 1: build the device, add a 2nd creator folder, add a photo.
    const store1 = createPhotoStore(
      makeFakeDeps({ storageDir, cacheDir, seedOnEmpty: false }),
    );
    await store1.ready();
    const created = await store1.createFolder("Holidays");
    expect(created[0]).toBeNull();
    const holidayId = created[1].folder.id;
    expect(created[1].folder.role).toBe("creator");

    const add1 = await store1.addBytes("beach.jpg", new Uint8Array([1, 2, 3, 4]));
    expect(add1[0]).toBeNull();
    await store1.close();

    // Session 2: simulate a restart — same storageDir, fresh in-memory drives.
    const store2 = createPhotoStore(
      makeFakeDeps({ storageDir, cacheDir, seedOnEmpty: false }),
    );
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

/** Hex-encode a buffer (mirrors the store's internal `hex`). */
const hexKey = (b: Buffer): string => b.toString("hex");

/**
 * Builds N stores whose p2p constructs are in-memory AND share ONE drive
 * registry, so a drive opened by key resolves to the same `FakeDrive` instance
 * across every store (modelling p2p replication). This is what lets us drive
 * genuine multi-device scenarios (#43/#49/#52) where a member's drive contents
 * are visible to another member's store.
 *
 * `ownDrive()` returns the device's identity drive (created on `ready()`), whose
 * key is random — so the test reads it back after `ready()` to enrol members.
 */
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
    const changes: Array<{ folderId: string }> = [];
    const deps = makeFakeDeps({
      deviceName: name,
      onChanged: (c) => changes.push({ folderId: c.folderId }),
      makeDrive: makeDriveFor(i),
    });
    // addBytes stages uploads into cacheDir, which the production runtime
    // pre-creates — mirror that here so staging doesn't throw.
    mkdirSync(deps.cacheDir, { recursive: true });
    const store = createPhotoStore(deps);
    return { store, changes, deps, ownDrive: () => meta[i].ownDrive! };
  });
  return { devices, cache };
}

describe("#49 a member re-adding another member's bytes must own its own copy", () => {
  it("writes a local copy instead of adopting the foreign entry", async () => {
    const { devices } = buildDevices(["Creator", "Alice", "Bob"]);
    const [creator, alice, bob] = devices;

    // Bring every device up so each has its (random) identity drive.
    await creator.store.ready();
    await alice.store.ready();
    await bob.store.ready();
    const aliceKey = hexKey(alice.ownDrive().key);
    const bobKey = hexKey(bob.ownDrive().key);

    // Creator makes a folder and pre-enrols both members. The fake has no p2p
    // peers, so we enrol directly via respond() (it only needs the member key).
    const created = await creator.store.createFolder("Family");
    expect(created[0]).toBeNull();
    const folderId = created[1].folder.id;
    const folderKey = created[1].folder.shareKey;
    await creator.store.respond(folderId, aliceKey, true);
    await creator.store.respond(folderId, bobKey, true);

    // Both join as members (the registry now lists them as enrolled). setup()
    // also auto-creates a "My Photos" creator folder, so target Family by key.
    const aj = await alice.store.join(folderKey);
    expect(aj[0]).toBeNull();
    const aliceFamily = (await alice.store.folders()).folders.find(
      (f) => f.shareKey === folderKey,
    )!;
    expect(aliceFamily.role).toBe("member");
    const bj = await bob.store.join(folderKey);
    expect(bj[0]).toBeNull();
    const bobFamily = (await bob.store.folders()).folders.find(
      (f) => f.shareKey === folderKey,
    )!;
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
    const bobKey = hexKey(bob.ownDrive().key);

    const created = await creator.store.createFolder("Trip");
    expect(created[0]).toBeNull();
    const folderId = created[1].folder.id;
    const folderKey = created[1].folder.shareKey;

    // Bob joins before being approved → pending reader (can read, cannot add).
    const bj = await bob.store.join(folderKey);
    expect(bj[0]).toBeNull();
    const bobFolder = (await bob.store.folders()).folders.find(
      (f) => f.shareKey === folderKey,
    )!;
    expect(bobFolder.role).toBe("reader");
    expect(bobFolder.pending).toBe(true);

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

    const after = (await bob.store.folders()).folders.find(
      (f) => f.shareKey === folderKey,
    )!;
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
    const { store, drives } = buildStore();
    await store.ready();

    const photo = new Uint8Array([9, 8, 7, 6, 5, 4]);

    // First add writes the photo and seeds the content index.
    const r1 = await store.addBytes("mine.jpg", photo);
    expect(r1[0]).toBeNull();
    const firstId = r1[1].id;

    // Simulate this device's own drive going unreachable right before a re-add
    // (a flaky peer / not-yet-replicated block). A live full-gallery scan would
    // now skip it and miss the existing copy.
    const own = drives[0];
    own.unreachable = true;

    // Re-adding the same bytes must dedupe in-session via the content index,
    // returning the SAME entry rather than writing a second copy.
    const r2 = await store.addBytes("mine.jpg", photo);
    expect(r2[0]).toBeNull();
    expect(r2[1].id).toBe(firstId);

    // No second photo was written to the drive.
    expect(own.countPhotos()).toBe(1);

    // After the drive recovers, the original is still there and dedupes.
    own.unreachable = false;
    const r3 = await store.addBytes("mine.jpg", photo);
    expect(r3[0]).toBeNull();
    expect(r3[1].id).toBe(firstId);
    expect(own.countPhotos()).toBe(1);

    await store.close();
  });
});
