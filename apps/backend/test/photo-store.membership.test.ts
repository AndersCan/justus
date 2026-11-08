/**
 * The members machine on the Admin's phone: Make Collaborator and left notes
 * go through one actor per person, one change at a time per album.
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

async function lists(s: Awaited<ReturnType<typeof album>>) {
  const status = await s.admin.status();
  return (status.members as { key: string; role?: string }[]).filter((m) => m.key === s.key);
}

describe("members machine", () => {
  it("two Make Collaborator calls at once leave the person a Collaborator once", async () => {
    const s = await album();
    const [a, b] = await Promise.all([
      s.admin.makeMember(s.folderId, s.key),
      s.admin.makeMember(s.folderId, s.key),
    ]);
    const oks = [a, b].filter((r) => r[0] === null);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    for (const r of [a, b])
      if (r[0] !== null) expect(String(r[0])).toMatch(/still being saved|no such viewer/i);
    expect(await lists(s)).toHaveLength(1);
    await s.close();
  }, 30_000);

  it("Make Collaborator racing a left note ends with the person off both lists", async () => {
    const s = await album();
    s.hold.on = true;
    expect((await s.ben.leaveAlbum(s.benFolderId))[0]).toBeNull();
    const call = s.admin.makeMember(s.folderId, s.key);
    s.release();
    const [error] = await call;
    if (error) expect(error.message).toBe("They left the album");
    await until(async () => (await lists(s)).length === 0);
    await s.close();
  }, 30_000);

  it("a left note older than the join changes nothing", async () => {
    const s = await album();
    expect((await s.ben.leaveAlbum(s.benFolderId))[0]).toBeNull();
    await until(async () => (await lists(s)).length === 0);
    await sleep(50);
    // Ben rejoins afterwards: the stale note must not drop him.
    const rejoinedKey = await joinAsMember(
      s.admin,
      s.folderId,
      s.ben,
      (await s.admin.folders()).folders[0]!.shareKey,
    );
    await sleep(1_500);
    expect(
      await s.admin.status().then((x) => (x.members as { key: string }[]).map((m) => m.key)),
    ).toContain(rejoinedKey);
    await s.close();
  }, 30_000);
});
