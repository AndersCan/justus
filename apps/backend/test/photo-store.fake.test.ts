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
