/**
 * A phone drops the cached copy of a photo someone else deleted, also when it was off at the time.
 * Anna (Admin) and Nils (Collaborator) on the checked fakes share one hub.
 */
import { describe, it, expect } from "vite-plus/test";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPhotoStore } from "../src/photo-store.ts";
import { parseSpoolName } from "../src/spool-name.ts";
import { createFakeHub, addFakeNode, setFakeNodeConnected } from "./fakes/fake-world.ts";
import {
  FakeLoopbackServer,
  fakeStoreDeps,
  joinAsMember,
  restarted,
} from "./fakes/fake-store-deps.ts";

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

/** Makes every `clearDeleted` on a drive the phone opens fail while `fail` is set. */
function failClearDeleted(deps: ReturnType<typeof phoneDeps>) {
  const gate = { fail: false, failed: 0 };
  const open = deps.drives.open.bind(deps.drives);
  deps.drives.open = (async (key: string, opts: { timeoutMs: number }) => {
    const r = await open(key, opts);
    const drive = r[1];
    if (drive) {
      const real = drive.clearDeleted.bind(drive);
      drive.clearDeleted = async (o: Parameters<typeof real>[0]) => {
        if (!gate.fail) return real(o);
        gate.failed += 1;
        return [new Error("disk busy"), null];
      };
    }
    return r;
  }) as typeof deps.drives.open;
  return gate;
}

async function album(opts: { failNils?: boolean } = {}) {
  const hub = createFakeHub();
  const annaDeps = phoneDeps(hub, "Anna");
  const anna = createPhotoStore(annaDeps);
  const nilsDeps = phoneDeps(hub, "Nils");
  const gate = opts.failNils ? failClearDeleted(nilsDeps) : undefined;
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
  return { hub, anna, nils, annaDeps, nilsDeps, folderId, nilsFolderId, shareKey, gate };
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
    const server = s.nilsDeps.server as FakeLoopbackServer;
    for (const url of [gone.url, gone.thumbUrl!])
      expect((await server.getForTest(new URL(url).pathname)).status).toBe(404);
    expect((await server.getForTest(new URL(stays.url).pathname)).status).toBe(200);
    await s.anna.close();
    await s.nils.close();
  });

  it("a phone whose cache was wiped still takes a photo the Collaborator deleted himself out of its record", async () => {
    const s = await album();
    await addWithThumb(s.nils, s.nilsDeps, s.nilsFolderId, "nils.jpg", 5);
    await until(async () => (await s.anna.list()).some((p) => p.name === "nils.jpg"));
    const photo = await load(s.annaDeps, s.anna, "nils.jpg");
    const own = await s.annaDeps.drives.openOwn(`folder/${s.folderId}`);
    const held = async () => {
      for await (const e of own.list("/held")) if (e.path.endsWith(`/${photo.id}`)) return true;
      return false;
    };
    await until(held);
    expect(await held()).toBe(true);
    rmSync(join(s.annaDeps.cacheDir, "photos", s.folderId), { recursive: true, force: true });
    setFakeNodeConnected({ hub: s.hub, node: s.annaDeps.node, connected: false });
    await s.nils.remove(photo.id, s.nilsFolderId);
    setFakeNodeConnected({ hub: s.hub, node: s.annaDeps.node, connected: true });
    await until(async () => !(await held()));
    expect(await held()).toBe(false);
    await s.anna.close();
    await s.nils.close();
  }, 30_000);

  it("a phone ignores a Collaborator's deleted photos when his holding record is a version it does not know", async () => {
    const s = await album();
    await addWithThumb(s.nils, s.nilsDeps, s.nilsFolderId, "nils.jpg", 5);
    await until(async () => (await s.anna.list()).some((p) => p.name === "nils.jpg"));
    const photo = await load(s.annaDeps, s.anna, "nils.jpg");
    const own = await s.annaDeps.drives.openOwn(`folder/${s.folderId}`);
    const held = async () => {
      for await (const e of own.list("/held")) if (e.path.endsWith(`/${photo.id}`)) return true;
      return false;
    };
    await until(held);
    await s.anna.close();
    await s.nils.remove(photo.id, s.nilsFolderId);
    const nilsOwn = await s.nilsDeps.drives.openOwn(`member/${s.shareKey}`);
    await nilsOwn.put("/holding.json", Buffer.from(JSON.stringify({ version: 2 })));
    rmSync(join(s.annaDeps.cacheDir, "photos", s.folderId), { recursive: true, force: true });
    const again = restarted(s.annaDeps);
    const reopened = createPhotoStore(again);
    await reopened.ready();
    await reopened.setActive(s.folderId);
    await reopened.list();
    await sleep(3_000);
    await reopened.list();
    const ownAgain = await again.drives.openOwn(`folder/${s.folderId}`);
    let kept = false;
    for await (const e of ownAgain.list("/held")) if (e.path.endsWith(`/${photo.id}`)) kept = true;
    expect(kept).toBe(true);
    await reopened.close();
    await s.nils.close();
  }, 30_000);

  it("a Collaborator whose delete record cannot be written still deletes the photo and logs it", async () => {
    const hub = createFakeHub();
    const annaDeps = phoneDeps(hub, "Anna");
    const anna = createPhotoStore(annaDeps);
    const nilsDeps = phoneDeps(hub, "Nils");
    const logs: { event: string; fields: Record<string, unknown> }[] = [];
    nilsDeps.log = (e: { event: string; fields: Record<string, unknown> }) => logs.push(e);
    const openOwn = nilsDeps.drives.openOwn.bind(nilsDeps.drives);
    nilsDeps.drives.openOwn = async (namespace?: string) => {
      const drive = await openOwn(namespace);
      const put = drive.put.bind(drive);
      drive.put = (async (...args: Parameters<typeof put>) => {
        if (String(args[0]).startsWith("/deleted-photos/")) throw new Error("disk busy");
        return put(...args);
      }) as typeof drive.put;
      return drive;
    };
    const nils = createPhotoStore(nilsDeps);
    await anna.ready();
    await nils.ready();
    const created = await anna.createFolder("Trip");
    const folderId = created[1]!.folder.id;
    const shareKey = created[1]!.folder.shareKey;
    await joinAsMember(anna, folderId, nils, shareKey);
    const nilsFolderId = (await nils.folders()).folders.find((f) => f.shareKey === shareKey)!.id;
    await nils.setActive(nilsFolderId);
    await addWithThumb(nils, nilsDeps, nilsFolderId, "nils.jpg", 5);
    const photo = await load(nilsDeps, nils, "nils.jpg");
    await nils.remove(photo.id, nilsFolderId);
    expect((await nils.list(nilsFolderId)).some((p) => p.id === photo.id)).toBe(false);
    expect(logs.some((l) => l.event === "error" && l.fields.where === "remove.ownDelete")).toBe(
      true,
    );
    await anna.close();
    await nils.close();
  }, 30_000);

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

describe("thumbnail bytes leave the phone", () => {
  it("the Admin's delete of Nils's photo clears the thumbnail bytes from Nils's drive", async () => {
    const s = await album();
    await addWithThumb(s.nils, s.nilsDeps, s.nilsFolderId, "mine.jpg", 5);
    const mine = (await find(s.nils, "mine.jpg"))!;
    const nilsKey = mine.member.key;
    const [, drive] = await s.nilsDeps.drives.open(nilsKey, { timeoutMs: 1_000 });
    const before = drive!.version();
    const [, then] = await s.nilsDeps.drives.openAt(nilsKey, before, { timeoutMs: 500 });
    expect(await then!.readBytes(`/thumbs/${mine.id}.jpg`)).toBeDefined();
    await until(async () => (await s.anna.list()).some((p) => p.name === "mine.jpg"));
    await s.anna.remove(mine.id);
    await until(async () => {
      const [, past] = await s.nilsDeps.drives.openAt(nilsKey, before, { timeoutMs: 500 });
      return (
        (await past!.readSmall(`/photos/${mine.id}.jpg`, 100, { timeoutMs: 200 })) === undefined
      );
    });
    const [, past] = await s.nilsDeps.drives.openAt(nilsKey, before, { timeoutMs: 500 });
    expect(
      await past!.readSmall(`/thumbs/${mine.id}.jpg`, 100, { timeoutMs: 200 }),
    ).toBeUndefined();
    await s.anna.close();
    await s.nils.close();
  }, 20_000);

  it("deleting your own photo clears its thumbnail bytes", async () => {
    const s = await album();
    await addWithThumb(s.anna, s.annaDeps, s.folderId, "mine.jpg", 5);
    const mine = (await find(s.anna, "mine.jpg"))!;
    const annaKey = mine.member.key;
    const [, drive] = await s.annaDeps.drives.open(annaKey, { timeoutMs: 1_000 });
    const before = drive!.version();
    const [, then] = await s.annaDeps.drives.openAt(annaKey, before, { timeoutMs: 500 });
    expect(await then!.readBytes(`/thumbs/${mine.id}.jpg`)).toBeDefined();
    await s.anna.remove(mine.id);
    const [, past] = await s.annaDeps.drives.openAt(annaKey, before, { timeoutMs: 500 });
    expect(
      await past!.readSmall(`/thumbs/${mine.id}.jpg`, 100, { timeoutMs: 200 }),
    ).toBeUndefined();
    await s.anna.close();
    await s.nils.close();
  }, 20_000);

  it("a phone whose cache was wiped keeps a deleted photo in its record while it cannot clear its bytes", async () => {
    const s = await album({ failNils: true });
    await addWithThumb(s.anna, s.annaDeps, s.folderId, "gone.jpg", 1);
    await until(async () => (await s.nils.list()).length === 1);
    const gone = await load(s.nilsDeps, s.nils, "gone.jpg");
    const shareKey = (await s.nils.folders()).folders.find(
      (f) => f.id === s.nilsFolderId,
    )!.shareKey;
    const own = await s.nilsDeps.drives.openOwn(`member/${shareKey}`);
    await until(async () => (await own.readSmall(`/held/${gone.id}`, 10)) !== undefined);
    rmSync(join(s.nilsDeps.cacheDir, "photos", s.nilsFolderId), { recursive: true, force: true });
    setFakeNodeConnected({ hub: s.hub, node: s.nilsDeps.node, connected: false });
    s.gate!.fail = true;
    await s.anna.remove(gone.id);
    setFakeNodeConnected({ hub: s.hub, node: s.nilsDeps.node, connected: true });
    await until(() => s.gate!.failed >= 2);
    await sleep(500);
    expect(await own.readSmall(`/held/${gone.id}`, 10)).toBeDefined();
    s.gate!.fail = false;
    await s.anna.addBytes("next.jpg", new Uint8Array([9, 9, 9]));
    await until(async () => (await own.readSmall(`/held/${gone.id}`, 10)) === undefined);
    await s.anna.close();
    await s.nils.close();
  }, 20_000);

  it("a phone whose cache was wiped still takes a photo the Admin deleted out of its record", async () => {
    const s = await album();
    await addWithThumb(s.anna, s.annaDeps, s.folderId, "gone.jpg", 1);
    await until(async () => (await s.nils.list()).length === 1);
    const gone = await load(s.nilsDeps, s.nils, "gone.jpg");
    const shareKey = (await s.nils.folders()).folders.find(
      (f) => f.id === s.nilsFolderId,
    )!.shareKey;
    const own = await s.nilsDeps.drives.openOwn(`member/${shareKey}`);
    await until(async () => (await own.readSmall(`/held/${gone.id}`, 10)) !== undefined);
    rmSync(join(s.nilsDeps.cacheDir, "photos", s.nilsFolderId), { recursive: true, force: true });
    setFakeNodeConnected({ hub: s.hub, node: s.nilsDeps.node, connected: false });
    await s.anna.remove(gone.id);
    setFakeNodeConnected({ hub: s.hub, node: s.nilsDeps.node, connected: true });
    await until(async () => (await own.readSmall(`/held/${gone.id}`, 10)) === undefined);
    await s.anna.close();
    await s.nils.close();
  }, 20_000);
});
