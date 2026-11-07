/**
 * Regression test for issue #156: content dedupe keyed only on `driveKey`, so
 * two folders that share `ownDrive.key` (a device's identity creator folder and
 * a member folder it joined) collided. Re-adding identical bytes to the member
 * folder matched the identity folder's index entry and returned its spool mount
 * WITHOUT writing the bytes to the member folder's drive — the photo was then
 * missing from the member folder's gallery.
 *
 * The fix scopes the content index by `folderId`, so a re-add is only deduped
 * within the SAME folder. Since #195 the two folders no longer share a drive at
 * all; the test still guards the per-folder scoping.
 */
import { describe, it, expect } from "vite-plus/test";
import { mkdirSync } from "node:fs";
import { createPhotoStore } from "../src/photo-store.ts";
import { createFakeHub } from "./fakes/fake-world.ts";
import { fakeStoreDeps, joinAsMember } from "./fakes/fake-store-deps.ts";

/** N stores on one hub, so they share drives the way replicating phones do. */
function buildDevices(names: string[]) {
  const hub = createFakeHub();
  const devices = names.map((name) => {
    const deps = fakeStoreDeps({ hub, deviceName: name });
    mkdirSync(deps.cacheDir, { recursive: true });
    const store = createPhotoStore(deps);
    return { store, deps };
  });
  return { devices };
}

describe("#156 content dedupe must be scoped per folder", () => {
  it("does not drop identical bytes re-added to a member folder", async () => {
    const { devices } = buildDevices(["X", "Y"]);
    const [x, y] = devices;

    await x.store.ready();
    await y.store.ready();

    // X starts its own folder; Y creates a folder and enrols X as a member, so
    // X now holds BOTH a creator folder AND a member folder.
    await x.store.createFolder("Mine");
    const created = await y.store.createFolder("FolderY");
    expect(created[0]).toBeNull();
    const folderYId = created[1]!.folder.id;
    const folderKey = created[1]!.folder.shareKey;
    await joinAsMember(y.store, folderYId, x.store, folderKey);
    const xFolders = (await x.store.folders()).folders;
    const myPhotos = xFolders.find((f) => f.name === "Mine")!;
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
    // identity folder. Before the fix this URL pointed
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
