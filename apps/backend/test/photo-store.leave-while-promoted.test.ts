/**
 * A Viewer leaves while the Admin makes them a Collaborator, in either order.
 * The Admin's phone reads the left note late; the person must still end up
 * off both lists, and their phone must not forget the note early. Two phones
 * share one hub on the checked fakes.
 */
import { describe, it, expect } from "vite-plus/test";
import { mkdirSync } from "node:fs";
import { createPhotoStore } from "../src/photo-store.ts";
import { createFakeHub, addFakeNode, setFakeNodeConnected } from "./fakes/fake-world.ts";
import { fakeStoreDeps, joinAsMember } from "./fakes/fake-store-deps.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function until(check: () => boolean | Promise<boolean>, ms = 8_000) {
  const deadline = Date.now() + ms;
  while (!(await check()) && Date.now() < deadline) await sleep(20);
  expect(await check()).toBe(true);
}

function phoneDeps(hub: ReturnType<typeof createFakeHub>, deviceName: string) {
  const node = addFakeNode(hub);
  setFakeNodeConnected({ hub, node, connected: true });
  const deps = fakeStoreDeps({ hub, node, deviceName });
  mkdirSync(deps.cacheDir, { recursive: true });
  return deps;
}

/** Other phones' drives reach the Admin's phone late: while `hold.on` is set their changes are not announced and `/left.json` reads as missing; `release()` announces them. */
function holdLeftNotes(deps: ReturnType<typeof phoneDeps>, hold: { on: boolean }) {
  const pending: (() => void)[] = [];
  const open = deps.drives.open.bind(deps.drives);
  deps.drives.open = async (key: string, opts: { timeoutMs: number }) => {
    const [err, drive] = await open(key, opts);
    if (err || !drive) return [err, drive] as never;
    const readSmall = drive.readSmall.bind(drive);
    drive.readSmall = async (path: string, max: number) =>
      hold.on && path === "/left.json" ? null : readSmall(path, max);
    const onChange = drive.onChange.bind(drive);
    drive.onChange = (cb: Parameters<typeof onChange>[0]) =>
      onChange((...args: Parameters<typeof cb>) => {
        if (hold.on) pending.push(() => cb(...args));
        else cb(...args);
      });
    return [null, drive];
  };
  return () => {
    hold.on = false;
    for (const run of pending.splice(0)) run();
  };
}

async function album() {
  const hub = createFakeHub();
  const hold = { on: false };
  const adminDeps = phoneDeps(hub, "Anna");
  const release = holdLeftNotes(adminDeps, hold);
  const admin = createPhotoStore(adminDeps);
  const ben = createPhotoStore(phoneDeps(hub, "Ben"));
  await admin.ready();
  await ben.ready();
  const created = await admin.createFolder("Trip");
  const folderId = created[1]!.folder.id;
  const shareKey = created[1]!.folder.shareKey;
  const key = await joinAsMember(admin, folderId, ben, shareKey);
  expect((await admin.makeViewer(folderId, key))[0]).toBeNull();
  const benFolderId = (await ben.folders()).folders.find((f) => f.shareKey === shareKey)!.id;
  await admin.setActive(folderId);
  const names = async () => {
    const status = await admin.status();
    return (status.members as { key: string }[]).map((m) => m.key);
  };
  const close = async () => {
    await admin.close();
    await ben.close();
  };
  return { admin, ben, hold, release, folderId, benFolderId, key, names, close };
}

describe("a Viewer leaves while being made a Collaborator", () => {
  it("is off both lists once the Admin's phone reads the note, and their phone still shows the album gone", async () => {
    const s = await album();
    s.hold.on = true;
    expect((await s.ben.leaveAlbum(s.benFolderId))[0]).toBeNull();
    expect((await s.admin.makeMember(s.folderId, s.key))[0]).toBeNull();
    await sleep(1_500);
    expect(await s.names()).toContain(s.key);
    s.release();
    await until(async () => !(await s.names()).includes(s.key));
    expect((await s.ben.folders()).folders).toEqual([]);
    const photoList = (await s.admin.list(s.folderId)).length;
    expect(photoList).toBe(0);
    await s.close();
  }, 30_000);

  it("their phone keeps waiting while the person moved to the Collaborators list", async () => {
    const s = await album();
    s.hold.on = true;
    expect((await s.ben.leaveAlbum(s.benFolderId))[0]).toBeNull();
    expect((await s.admin.makeMember(s.folderId, s.key))[0]).toBeNull();
    await sleep(1_500);
    const gone = () =>
      (s.ben.debugState() as { gone: { kind?: string }[] }).gone.map((g) => g.kind);
    expect(gone()).toEqual(["waitingForAdminToSeeYouLeft"]);
    s.release();
    await until(() => gone().length === 0);
    await s.close();
  }, 30_000);

  it("promoting first, then leaving, drops the person too", async () => {
    const s = await album();
    expect((await s.admin.makeMember(s.folderId, s.key))[0]).toBeNull();
    expect((await s.ben.leaveAlbum(s.benFolderId))[0]).toBeNull();
    await until(async () => !(await s.names()).includes(s.key));
    await until(() => (s.ben.debugState() as { gone: unknown[] }).gone.length === 0);
    await s.close();
  }, 30_000);
});
