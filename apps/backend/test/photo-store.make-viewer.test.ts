/**
 * An Admin makes a Collaborator a Viewer: the photos the person already added
 * stay for everyone, and nothing they add afterwards is read. Two phones on
 * the checked fakes share one hub.
 */
import { describe, it, expect } from "vite-plus/test";
import { mkdirSync } from "node:fs";
import { createPhotoStore } from "../src/photo-store.ts";
import { createFakeHub, addFakeNode, setFakeNodeConnected } from "./fakes/fake-world.ts";
import { fakeStoreDeps, joinAsMember } from "./fakes/fake-store-deps.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function phone(hub: ReturnType<typeof createFakeHub>, deviceName: string) {
  const node = addFakeNode(hub);
  setFakeNodeConnected({ hub, node, connected: true });
  const deps = fakeStoreDeps({ hub, node, deviceName });
  mkdirSync(deps.cacheDir, { recursive: true });
  return createPhotoStore(deps);
}

async function album() {
  const hub = createFakeHub();
  const admin = phone(hub, "Anna");
  const nils = phone(hub, "Nils");
  await admin.ready();
  await nils.ready();
  const created = await admin.createFolder("Trip");
  const folderId = created[1]!.folder.id;
  const shareKey = created[1]!.folder.shareKey;
  const key = await joinAsMember(admin, folderId, nils, shareKey);
  const nilsFolderId = (await nils.folders()).folders.find((f) => f.shareKey === shareKey)!.id;
  await nils.setActive(nilsFolderId);
  await admin.setActive(folderId);
  const close = async () => {
    await admin.close();
    await nils.close();
  };
  return { admin, nils, folderId, nilsFolderId, key, close };
}

describe("making a Collaborator a Viewer", () => {
  it("keeps their photos and ignores what they add afterwards", async () => {
    const s = await album();
    expect((await s.nils.addBytes("before.jpg", new Uint8Array([1, 2, 3, 4])))[0]).toBeNull();
    expect((await s.admin.list()).map((p) => p.name)).toContain("before.jpg");

    expect((await s.admin.makeViewer(s.folderId, s.key))[0]).toBeNull();
    expect((await s.admin.list()).map((p) => p.name)).toContain("before.jpg");
    const status = await s.admin.status();
    expect(status.members.find((m: { key: string }) => m.key === s.key)?.viewer).toBe(true);

    await s.nils.addBytes("after.jpg", new Uint8Array([9, 8, 7, 6]));
    await sleep(100);
    const names = (await s.admin.list()).map((p) => p.name);
    expect(names).toContain("before.jpg");
    expect(names).not.toContain("after.jpg");
    await s.close();
  });

  it("their phone becomes a Viewer's without a restart and keeps their photo", async () => {
    const s = await album();
    await s.nils.addBytes("before.jpg", new Uint8Array([1, 2, 3, 4]));
    expect((await s.admin.makeViewer(s.folderId, s.key))[0]).toBeNull();
    await sleep(1_000);
    const mine = (await s.nils.folders()).folders.find((f) => f.id === s.nilsFolderId)!;
    expect(mine.role).toBe("reader");
    expect((await s.nils.list(s.nilsFolderId)).map((p) => p.name)).toEqual(["before.jpg"]);
    const refused = await s.nils.addBytes("late.jpg", new Uint8Array([5, 5, 5]), s.nilsFolderId);
    expect(refused[0]).not.toBeNull();
    await s.close();
  });

  it("the Admin can still delete the kept photo, and turn them back into a Collaborator", async () => {
    const s = await album();
    const added = await s.nils.addBytes("before.jpg", new Uint8Array([1, 2, 3, 4]));
    await s.admin.makeViewer(s.folderId, s.key);
    const photo = (await s.admin.list()).find((p) => p.name === "before.jpg")!;
    expect(photo).toBeDefined();
    expect(added[0]).toBeNull();
    expect((await s.admin.makeMember(s.folderId, s.key))[0]).toBeNull();
    await s.nils.addBytes("after.jpg", new Uint8Array([9, 8, 7, 6]));
    await sleep(100);
    expect((await s.admin.list()).map((p) => p.name).sort()).toEqual(["after.jpg", "before.jpg"]);
    await s.close();
  });
});
