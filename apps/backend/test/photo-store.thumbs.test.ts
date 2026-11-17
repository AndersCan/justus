/**
 * Phones fetch each other's missing previews on their own once they are connected:
 * nobody opens a photo, and the preview still lands in the receiving phone's record.
 */
import { describe, it, expect } from "vite-plus/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPhotoStore } from "../src/photo-store.ts";
import { createFakeHub, addFakeNode, setFakeNodeConnected } from "./fakes/fake-world.ts";
import { FakeLoopbackServer, fakeStoreDeps, joinAsMember } from "./fakes/fake-store-deps.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function until(done: () => boolean | Promise<boolean>, ms = 4_000): Promise<void> {
  for (let waited = 0; waited < ms && !(await done()); waited += 20) await sleep(20);
}

function phone(hub: ReturnType<typeof createFakeHub>, deviceName: string) {
  const node = addFakeNode(hub);
  setFakeNodeConnected({ hub, node, connected: true });
  const logs: { event: string; fields: Record<string, unknown> }[] = [];
  const deps = fakeStoreDeps({
    hub,
    node,
    deviceName,
    server: new FakeLoopbackServer(),
    log: (e: { event: string; fields: Record<string, unknown> }) => logs.push(e),
  });
  const stuck = { on: false };
  const open = deps.drives.open.bind(deps.drives);
  deps.drives.open = async (key: string, opts: { timeoutMs: number }) => {
    const opened = await open(key, opts);
    const drive = opened[1];
    if (drive) {
      const download = drive.download.bind(drive);
      drive.download = async (path: string, o: { timeoutMs: number }) =>
        stuck.on ? "timedOut" : download(path, o);
    }
    return opened;
  };
  mkdirSync(deps.cacheDir, { recursive: true });
  return { deps, logs, stuck, store: createPhotoStore(deps) };
}

async function album() {
  const hub = createFakeHub();
  const anna = phone(hub, "Anna");
  const nils = phone(hub, "Nils");
  await anna.store.ready();
  await nils.store.ready();
  const created = await anna.store.createFolder("Trip");
  const folderId = created[1]!.folder.id;
  const shareKey = created[1]!.folder.shareKey;
  const nilsKey = await joinAsMember(anna.store, folderId, nils.store, shareKey);
  const nilsFolderId = (await nils.store.folders()).folders.find(
    (f) => f.shareKey === shareKey,
  )!.id;
  await nils.store.setActive(nilsFolderId);
  await anna.store.setActive(folderId);
  // The phones meet, so each sees the other as connected.
  const nilsTopic = nils.deps.drives.discoveryKeyOf(
    (nils.store.debugState() as { identityDrive: string }).identityDrive,
  );
  anna.deps.network.join(nilsTopic, { server: false });
  await until(async () =>
    (await nils.store.status()).members.some(
      (m: { admin: boolean; connected: boolean }) => m.admin && m.connected,
    ),
  );
  const addThumbed = async (name: string) => {
    const display = join(anna.deps.cacheDir, `${name}-display.jpg`);
    const thumb = join(anna.deps.cacheDir, `${name}-thumb.jpg`);
    writeFileSync(display, new Uint8Array([10, 11, 12, name.charCodeAt(0)]));
    writeFileSync(thumb, new Uint8Array([20, 21]));
    expect((await anna.store.add(display, name, folderId, { thumb }))[0]).toBeNull();
  };
  const nilsPhoto = async (name: string) =>
    (await nils.store.list(nilsFolderId)).find((p) => p.name === name);
  const annaPhoto = async (name: string) =>
    (await anna.store.list(folderId)).find((p) => p.name === name)!;
  return { hub, anna, nils, folderId, nilsKey, nilsFolderId, addThumbed, nilsPhoto, annaPhoto };
}

describe("background previews", () => {
  it("Nils gets Anna's preview by only listing, and Anna sees it", async () => {
    const s = await album();
    await s.addThumbed("a.jpg");
    await until(async () => (await s.nilsPhoto("a.jpg"))?.holders?.previewHere === true);
    expect((await s.nilsPhoto("a.jpg"))!.holders).toMatchObject({ here: false, previewHere: true });
    await until(async () => (await s.annaPhoto("a.jpg")).holders!.previews.length === 1);
    const holders = (await s.annaPhoto("a.jpg")).holders!;
    expect(
      holders.kind === "inAlbum" && holders.previews.map((m: { key: string }) => m.key),
    ).toEqual([s.nilsKey]);
    expect(holders.kind === "inAlbum" && holders.waiting).toEqual([]);
    expect(s.nils.logs.some((l) => l.event === "thumbs.fetch" && l.fields.fetched === 1)).toBe(
      true,
    );
  });

  it("fetches nothing while Anna's phone does not send, and says so in the log", async () => {
    const s = await album();
    s.nils.stuck.on = true;
    await s.addThumbed("a.jpg");
    await until(async () => {
      await s.nilsPhoto("a.jpg");
      return s.nils.logs.some((l) => l.fields.stopped === "timedOut");
    });
    expect(s.nils.logs.some((l) => l.fields.stopped === "timedOut")).toBe(true);
    expect((await s.nilsPhoto("a.jpg"))!.holders).toMatchObject({ previewHere: false });
  });

  it("a removed phone fetches nothing more of the album", async () => {
    const s = await album();
    await s.addThumbed("a.jpg");
    await until(async () => (await s.nilsPhoto("a.jpg"))?.holders?.previewHere === true);
    expect((await s.anna.store.removeMember(s.folderId, s.nilsKey))[0]).toBeNull();
    await until(async () => (await s.nils.store.folders()).folders[0]?.notice?.kind === "removed");
    await s.addThumbed("b.jpg");
    await until(async () => (await s.anna.store.list(s.folderId)).length === 2);
    await sleep(400);
    const b = (await s.nils.store.list(s.nilsFolderId)).find((p) => p.name === "b.jpg");
    expect(b?.holders?.kind !== "inAlbum" || !b.holders.previewHere).toBe(true);
    expect((await s.annaPhoto("b.jpg")).holders).toMatchObject({ previews: [] });
  });
});
