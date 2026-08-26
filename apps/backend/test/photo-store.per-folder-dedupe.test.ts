/**
 * Regression test for issue #156: content dedupe keyed only on `driveKey`, so
 * two folders that share `ownDrive.key` (a device's identity creator folder and
 * a member folder it joined) collided. Re-adding identical bytes to the member
 * folder matched the identity folder's index entry and returned its spool mount
 * WITHOUT writing the bytes to the member folder's drive — the photo was then
 * missing from the member folder's gallery.
 *
 * The fix scopes the content index by `folderId`, so a re-add is only deduped
 * within the SAME folder.
 */
import { describe, it, expect } from "vite-plus/test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPhotoStore } from "../src/photo-store.ts";
import { makeFakeDeps, FakeDrive } from "./fake-drive.ts";

const hexKey = (b: Buffer): string => b.toString("hex");

/** Mirrors the multi-device harness in photo-store.fake.test.ts: N in-memory
 * stores that share ONE drive registry, so a drive opened by key resolves to the
 * same `FakeDrive` across stores (modelling p2p replication). */
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
  return { devices };
}

describe("#156 content dedupe must be scoped per folder", () => {
  it("does not drop identical bytes re-added to a member folder that shares ownDrive.key", async () => {
    const { devices } = buildDevices(["X", "Y"]);
    const [x, y] = devices;

    await x.store.ready();
    await y.store.ready();
    const xKey = hexKey(x.ownDrive().key);

    // Y creates a folder and enrols X as a member.
    const created = await y.store.createFolder("FolderY");
    expect(created[0]).toBeNull();
    const folderYId = created[1]!.folder.id;
    const folderKey = created[1]!.folder.shareKey;
    await y.store.respond(folderYId, xKey, true);

    // X joins FolderY as a member, so X now holds BOTH its identity creator
    // folder (folderDrive === ownDrive) AND a member folder (selfDrive === ownDrive).
    const joined = await x.store.join(folderKey);
    expect(joined[0]).toBeNull();
    const xFolders = (await x.store.folders()).folders;
    const myPhotos = xFolders.find((f) => f.name === "My Photos")!;
    const memberFolder = xFolders.find((f) => f.shareKey === folderKey)!;
    expect(myPhotos.role).toBe("creator");
    expect(memberFolder.role).toBe("member");

    const bytes = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1]);

    // Add `bytes` to the identity folder.
    await x.store.setActive(myPhotos.id);
    const myAdd = await x.store.addBytes("mine.jpg", bytes);
    expect(myAdd[0]).toBeNull();
    expect((myAdd[1] as { url: string }).url).toContain(myPhotos.id);

    // Add the SAME bytes to the member folder.
    await x.store.setActive(memberFolder.id);
    const famAdd = await x.store.addBytes("theirs.jpg", bytes);
    expect(famAdd[0]).toBeNull();
    // Regression guard: the member-folder add must NOT be deduped against the
    // identity folder (they share ownDrive.key). Before the fix this URL pointed
    // at myPhotos.id and the bytes were never written to the member folder.
    expect((famAdd[1] as { url: string }).url).toContain(memberFolder.id);
    expect((famAdd[1] as { url: string }).url).not.toContain(myPhotos.id);

    // The photo must actually appear in the member folder's gallery.
    const inFolderY = await x.store.list();
    expect(inFolderY.length).toBe(1);
    expect(inFolderY[0]!.id).toBe((famAdd[1] as { id: string }).id);

    await x.store.close();
    await y.store.close();
  });
});
