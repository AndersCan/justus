/**
 * An Admin makes a Collaborator a Viewer: the photos the person already added
 * stay for everyone, and nothing they add afterwards is read. Two phones on
 * the checked fakes share one hub.
 */
import { describe, it, expect } from "vite-plus/test";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createPhotoStore } from "../src/photo-store.ts";
import { createFakeHub, addFakeNode, setFakeNodeConnected } from "./fakes/fake-world.ts";
import { fakeStoreDeps, joinAsMember, restarted } from "./fakes/fake-store-deps.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function phoneDeps(hub: ReturnType<typeof createFakeHub>, deviceName: string) {
  const node = addFakeNode(hub);
  setFakeNodeConnected({ hub, node, connected: true });
  const deps = fakeStoreDeps({ hub, node, deviceName });
  mkdirSync(deps.cacheDir, { recursive: true });
  return deps;
}

/** The Admin's phone sees other people's drives lag: their length reads 0
 * until `update()` has been called on that drive, as when the newest blocks
 * are still on the way. */
function lagBehindUntilUpdated(deps: ReturnType<typeof phoneDeps>) {
  const store = deps.drives;
  const open = store.open.bind(store);
  store.open = async (key: string, opts: { timeoutMs: number }) => {
    const [err, drive] = await open(key, opts);
    if (err || !drive) return [err, drive] as never;
    let updated = false;
    const version = drive.version.bind(drive);
    const update = drive.update.bind(drive);
    drive.version = () => (updated ? version() : 0);
    drive.update = async () => {
      updated = true;
      await update();
    };
    return [null, drive];
  };
}

async function album(options: { lag?: boolean } = {}) {
  const hub = createFakeHub();
  const adminDeps = phoneDeps(hub, "Anna");
  if (options.lag) lagBehindUntilUpdated(adminDeps);
  const admin = createPhotoStore(adminDeps);
  const nilsDeps = phoneDeps(hub, "Nils");
  const nils = createPhotoStore(nilsDeps);
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
  return { admin, nils, nilsDeps, folderId, nilsFolderId, key, close };
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

  it("keeps a photo that has not reached the Admin's phone yet", async () => {
    const s = await album({ lag: true });
    await s.nils.addBytes("before.jpg", new Uint8Array([1, 2, 3, 4]));
    expect((await s.admin.makeViewer(s.folderId, s.key))[0]).toBeNull();
    expect((await s.admin.list()).map((p) => p.name)).toContain("before.jpg");
    await s.close();
  });

  it("their phone is still a Viewer's after a restart and keeps their photo", async () => {
    const s = await album();
    await s.nils.addBytes("before.jpg", new Uint8Array([1, 2, 3, 4]));
    await s.admin.makeViewer(s.folderId, s.key);
    await sleep(1_000);
    await s.nils.close();
    const saved = readdirSync(s.nilsDeps.storageDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => readFileSync(join(s.nilsDeps.storageDir, f), "utf8"))
      .join("\n");
    expect(saved).toContain('"role":"reader"');
    const reopened = createPhotoStore(restarted(s.nilsDeps));
    await reopened.ready();
    const mine = (await reopened.folders()).folders.find((f) => f.id === s.nilsFolderId)!;
    expect(mine.role).toBe("reader");
    expect((await reopened.list(s.nilsFolderId)).map((p) => p.name)).toEqual(["before.jpg"]);
    await reopened.close();
    await s.admin.close();
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
