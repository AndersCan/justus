/**
 * A member who heard the Admin's delete keeps the note and passes it on, so a member who
 * was away hears it when the Admin's phone is gone. Over the checked fake drives.
 */
import { describe, expect, it } from "vite-plus/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPhotoStore, type PhotoStore } from "../../src/photo-store.ts";
import { PASS_ON_DELETE_MS } from "../../src/albums/lifecycle.ts";
import { addFakeNode, createFakeHub, setFakeNodeConnected } from "../fakes/fake-world.ts";
import {
  fakeStoreDeps,
  joinAsMember,
  restarted,
  type FakeStoreDeps,
} from "../fakes/fake-store-deps.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function until(done: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  for (let waited = 0; waited < ms && !(await done()); waited += 20) await sleep(20);
}

type Phone = { deps: FakeStoreDeps; store: PhotoStore };

function phone(hub: ReturnType<typeof createFakeHub>, deviceName: string): Phone {
  const node = addFakeNode(hub);
  setFakeNodeConnected({ hub, node, connected: true });
  const deps = fakeStoreDeps({ hub, node, deviceName });
  mkdirSync(deps.cacheDir, { recursive: true });
  return { deps, store: createPhotoStore(deps) };
}

async function away(p: Phone) {
  await p.store.close();
  setFakeNodeConnected({ hub: p.deps.hub, node: p.deps.node, connected: false });
}

async function back(p: Phone, restart = true) {
  setFakeNodeConnected({ hub: p.deps.hub, node: p.deps.node, connected: true });
  if (!restart) return;
  p.deps = restarted(p.deps);
  p.store = createPhotoStore(p.deps);
  await p.store.ready();
}

async function restart(p: Phone) {
  await p.store.close();
  await back(p);
}

/** Anna's album "Hytta" with a photo; Nils and Maya are Members who list the photo. */
async function album() {
  const hub = createFakeHub();
  const anna = phone(hub, "Anna");
  const nils = phone(hub, "Nils");
  const maya = phone(hub, "Maya");
  for (const p of [anna, nils, maya]) await p.store.ready();
  const { id, shareKey } = (await anna.store.createFolder("Hytta"))[1]!.folder;
  await anna.store.addBytes("a.jpg", new Uint8Array([1, 2, 3]), id);
  for (const p of [nils, maya]) {
    await joinAsMember(anna.store, id, p.store, shareKey);
    await until(async () => (await p.store.list({ all: true })).length === 1);
  }
  return { hub, anna, nils, maya, id, shareKey };
}

const hasAlbum = async (p: Phone, shareKey: string) =>
  (await p.store.folders()).folders.some((f) => f.shareKey === shareKey);
const noticeOf = async (p: Phone) => (await p.store.folders()).deleted.map(({ id: _, ...n }) => n);
const goneOf = (p: Phone) =>
  (JSON.parse(readFileSync(join(p.deps.storageDir, "justus.json"), "utf8")).gone ?? []) as {
    kind: string;
    passOn?: true;
    dismissed?: true;
    at: number;
  }[];

/** Maya is away, Anna deletes, Nils hears. */
async function nilsHeard() {
  const s = await album();
  await away(s.maya);
  expect((await s.anna.store.deleteAlbum(s.id))[0]).toBeNull();
  await until(async () => (await s.nils.store.folders()).deleted.length === 1);
  return s;
}

const HYTTA = [{ name: "Hytta", adminName: "Anna" }];

describe("a member passes a delete on", () => {
  it("an away member hears a delete from another member", async () => {
    const s = await nilsHeard();
    expect(await noticeOf(s.nils)).toEqual(HYTTA);
    await away(s.anna);
    await back(s.maya);
    await until(async () => !(await hasAlbum(s.maya, s.shareKey)));
    expect(await hasAlbum(s.maya, s.shareKey)).toBe(false);
    await until(async () => (await s.maya.store.folders()).deleted.length === 1);
    expect(await noticeOf(s.maya)).toEqual(HYTTA);
    expect(await s.maya.store.list({ all: true })).toEqual([]);
  }, 40_000);

  it("keeps only the delete note on the member who passes it on", async () => {
    const s = await nilsHeard();
    await away(s.anna);
    const [, drive] = await s.nils.deps.drives.open(s.shareKey, { timeoutMs: 1_000 });
    expect(await drive!.readSmall("/deleted.json", 10_000)).toBeDefined();
    for await (const entry of drive!.list("/photos")) {
      expect(await drive!.readBytes(entry.path)).toBeUndefined();
    }
    expect(goneOf(s.nils)).toMatchObject([{ kind: "deletedByAdmin", passOn: true }]);
  }, 40_000);

  it("passes it on after its own restart", async () => {
    const s = await nilsHeard();
    await away(s.anna);
    await restart(s.nils);
    await back(s.maya);
    await until(async () => (await s.maya.store.folders()).deleted.length === 1);
    expect(await hasAlbum(s.maya, s.shareKey)).toBe(false);
    expect(await noticeOf(s.maya)).toEqual(HYTTA);
  }, 40_000);

  it("keeps passing it on after the notice is dismissed", async () => {
    const s = await nilsHeard();
    const nilsNotice = (await s.nils.store.folders()).deleted[0];
    expect((await s.nils.store.dismissAlbumNotice(nilsNotice.id))[0]).toBeNull();
    expect(await noticeOf(s.nils)).toEqual([]);
    expect(goneOf(s.nils)).toMatchObject([{ passOn: true, dismissed: true }]);
    await away(s.anna);
    await restart(s.nils);
    await back(s.maya);
    await until(async () => (await s.maya.store.folders()).deleted.length === 1);
    expect(await noticeOf(s.maya)).toEqual(HYTTA);
    expect(await noticeOf(s.nils)).toEqual([]);
    expect((await s.nils.store.dismissAlbumNotice(nilsNotice.id))[0]?.code).toBe(
      "justus.photos/folder-not-found",
    );
  }, 40_000);

  it("stops passing it on after 90 days and keeps the notice", async () => {
    const s = await nilsHeard();
    await away(s.anna);
    await s.nils.store.close();
    const file = join(s.nils.deps.storageDir, "justus.json");
    const saved = JSON.parse(readFileSync(file, "utf8"));
    saved.gone[0].at = Date.now() - PASS_ON_DELETE_MS - 1;
    writeFileSync(file, JSON.stringify(saved));
    await back(s.nils);
    expect(s.nils.deps.node.replicas.has(s.shareKey)).toBe(false);
    expect(goneOf(s.nils)).toMatchObject([{ kind: "deletedByAdmin" }]);
    expect(goneOf(s.nils)[0].passOn).toBeUndefined();
    expect(await noticeOf(s.nils)).toEqual(HYTTA);
  }, 40_000);
});
