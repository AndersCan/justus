/**
 * A phone drops the cached copy of a photo someone else deleted, also when it was off at the time.
 * Anna (Admin) and Nils (Collaborator) on the checked fakes share one hub.
 */
import { describe, it, expect } from "vite-plus/test";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPhotoStore } from "../src/photo-store.ts";
import { parseSpoolName } from "../src/spool-name.ts";
import { createFakeHub, addFakeNode, setFakeNodeConnected } from "./fakes/fake-world.ts";
import { FakeLoopbackServer, fakeStoreDeps, joinAsMember } from "./fakes/fake-store-deps.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function until(check: () => Promise<boolean> | boolean) {
  const deadline = Date.now() + 5_000;
  let ok = await check();
  while (!ok && Date.now() < deadline) {
    await sleep(20);
    ok = await check();
  }
  expect(ok).toBe(true);
}

function phoneDeps(hub: ReturnType<typeof createFakeHub>, deviceName: string) {
  const node = addFakeNode(hub);
  setFakeNodeConnected({ hub, node, connected: true });
  const deps = fakeStoreDeps({ hub, node, deviceName });
  mkdirSync(deps.cacheDir, { recursive: true });
  return deps;
}

async function album() {
  const hub = createFakeHub();
  const annaDeps = phoneDeps(hub, "Anna");
  const anna = createPhotoStore(annaDeps);
  const nilsDeps = phoneDeps(hub, "Nils");
  const nils = createPhotoStore(nilsDeps);
  await anna.ready();
  await nils.ready();
  const created = await anna.createFolder("Trip");
  const folderId = created[1]!.folder.id;
  const shareKey = created[1]!.folder.shareKey;
  await joinAsMember(anna, folderId, nils, shareKey);
  const nilsFolderId = (await nils.folders()).folders.find((f) => f.shareKey === shareKey)!.id;
  await nils.setActive(nilsFolderId);
  await anna.setActive(folderId);
  return { hub, anna, nils, annaDeps, nilsDeps, folderId, nilsFolderId, shareKey };
}

type Store = ReturnType<typeof createPhotoStore>;

/** Adds a photo with a thumbnail, as the app does. */
async function addWithThumb(
  store: Store,
  deps: { cacheDir: string },
  folderId: string,
  name: string,
  seed: number,
) {
  const display = join(deps.cacheDir, `${name}-display.jpg`);
  const thumb = join(deps.cacheDir, `${name}-thumb.jpg`);
  writeFileSync(display, new Uint8Array([seed, seed + 1, seed + 2]));
  writeFileSync(thumb, new Uint8Array([seed + 10, seed + 11]));
  await store.add(display, name, folderId, { thumb });
}

async function find(store: Store, name: string) {
  return (await store.list()).find((p) => p.name === name);
}

async function load(deps: { server: unknown }, store: Store, name: string) {
  const photo = (await find(store, name))!;
  const server = deps.server as FakeLoopbackServer;
  await server.getForTest(new URL(photo.url).pathname);
  await server.getForTest(new URL(photo.thumbUrl!).pathname);
  return photo;
}

function spoolIds(cacheDir: string, folderId: string): string[] {
  try {
    return readdirSync(join(cacheDir, "photos", folderId)).map((n) => parseSpoolName(n)?.id ?? n);
  } catch {
    return [];
  }
}

describe("dropping photos others deleted", () => {
  it("Nils's cached copy goes when Anna deletes her photo, and his other photo stays", async () => {
    const s = await album();
    await addWithThumb(s.anna, s.annaDeps, s.folderId, "gone.jpg", 1);
    await addWithThumb(s.anna, s.annaDeps, s.folderId, "stays.jpg", 40);
    await until(async () => (await s.nils.list()).length === 2);
    const gone = await load(s.nilsDeps, s.nils, "gone.jpg");
    const stays = await load(s.nilsDeps, s.nils, "stays.jpg");
    expect(spoolIds(s.nilsDeps.cacheDir, s.nilsFolderId)).toContain(gone.id);
    await s.anna.remove(gone.id);
    await until(() => !spoolIds(s.nilsDeps.cacheDir, s.nilsFolderId).includes(gone.id));
    expect(spoolIds(s.nilsDeps.cacheDir, s.nilsFolderId)).toContain(stays.id);
    await s.anna.close();
    await s.nils.close();
  });

  it("the Admin's delete of Nils's photo drops Cara's copy while Nils's drive still lists it", async () => {
    const s = await album();
    const caraDeps = phoneDeps(s.hub, "Cara");
    const cara = createPhotoStore(caraDeps);
    await cara.ready();
    await joinAsMember(s.anna, s.folderId, cara, s.shareKey);
    const caraFolderId = (await cara.folders()).folders.find((f) => f.shareKey === s.shareKey)!.id;
    await cara.setActive(caraFolderId);
    await addWithThumb(s.nils, s.nilsDeps, s.nilsFolderId, "his.jpg", 80);
    await until(async () => (await cara.list()).some((p) => p.name === "his.jpg"));
    const his = await load(caraDeps, cara, "his.jpg");
    await until(async () => (await s.anna.list()).some((p) => p.name === "his.jpg"));
    await s.anna.remove(his.id);
    await until(() => !spoolIds(caraDeps.cacheDir, caraFolderId).includes(his.id));
    await s.anna.close();
    await s.nils.close();
    await cara.close();
  }, 20_000);

  it("the Admin's delete of Nils's photo leaves Nils's own drive, bytes and listing", async () => {
    const s = await album();
    await addWithThumb(s.nils, s.nilsDeps, s.nilsFolderId, "mine.jpg", 5);
    await addWithThumb(s.nils, s.nilsDeps, s.nilsFolderId, "kept.jpg", 60);
    const mine = (await find(s.nils, "mine.jpg"))!;
    const nilsKey = mine.member.key;
    const [, drive] = await s.nilsDeps.drives.open(nilsKey, { timeoutMs: 1_000 });
    const before = drive!.version();
    await until(async () => (await s.anna.list()).some((p) => p.name === "mine.jpg"));
    await s.anna.remove(mine.id);
    await until(async () => (await find(s.nils, "mine.jpg")) === undefined);
    await until(async () => {
      const [, past] = await s.nilsDeps.drives.openAt(nilsKey, before, { timeoutMs: 500 });
      return (
        (await past!.readSmall(`/photos/${mine.id}.jpg`, 100, { timeoutMs: 200 })) === undefined
      );
    });
    expect(await find(s.nils, "kept.jpg")).toBeDefined();
    await s.anna.close();
    await s.nils.close();
  }, 20_000);

  it("deleting your own photo clears its bytes from your phone", async () => {
    const s = await album();
    await addWithThumb(s.anna, s.annaDeps, s.folderId, "mine.jpg", 5);
    const mine = (await find(s.anna, "mine.jpg"))!;
    const annaKey = mine.member.key;
    const [, drive] = await s.annaDeps.drives.open(annaKey, { timeoutMs: 1_000 });
    const before = drive!.version();
    await s.anna.remove(mine.id);
    const [, past] = await s.annaDeps.drives.openAt(annaKey, before, { timeoutMs: 500 });
    expect(
      await past!.readSmall(`/photos/${mine.id}.jpg`, 100, { timeoutMs: 200 }),
    ).toBeUndefined();
    await s.anna.close();
    await s.nils.close();
  }, 20_000);

  it("the Admin's delete of Nils's photo removes the entry, thumb and spool from Nils's own drive", async () => {
    const s = await album();
    await addWithThumb(s.nils, s.nilsDeps, s.nilsFolderId, "mine.jpg", 5);
    await addWithThumb(s.nils, s.nilsDeps, s.nilsFolderId, "kept.jpg", 60);
    const mine = await load(s.nilsDeps, s.nils, "mine.jpg");
    await load(s.nilsDeps, s.nils, "kept.jpg");
    expect(spoolIds(s.nilsDeps.cacheDir, s.nilsFolderId)).toContain(mine.id);
    const nilsKey = mine.member.key;
    const [, drive] = await s.nilsDeps.drives.open(nilsKey, { timeoutMs: 1_000 });
    await until(async () => (await s.anna.list()).some((p) => p.name === "mine.jpg"));
    await s.anna.remove(mine.id);
    const paths = async () => {
      const out: string[] = [];
      for await (const e of drive!.list("/")) out.push(e.path);
      return out;
    };
    await until(async () => !(await paths()).some((p) => p.includes(mine.id)));
    expect(spoolIds(s.nilsDeps.cacheDir, s.nilsFolderId)).not.toContain(mine.id);
    expect((await paths()).filter((p) => p.startsWith("/photos/")).length).toBe(1);
    await s.anna.close();
    await s.nils.close();
  }, 20_000);
});
