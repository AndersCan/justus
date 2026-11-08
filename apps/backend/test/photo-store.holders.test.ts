/**
 * Phones record the photos they hold a full copy of and read each other's
 * records, so every listed photo says who has it. Phones share one hub on the
 * checked fakes.
 */
import { describe, it, expect } from "vite-plus/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Drive } from "../src/ports/drive-store.ts";
import { createPhotoStore } from "../src/photo-store.ts";
import { spoolNameFor } from "../src/spool-name.ts";
import { createFakeHub, addFakeNode, setFakeNodeConnected } from "./fakes/fake-world.ts";
import {
  FakeLoopbackServer,
  fakeStoreDeps,
  joinAsMember,
  restarted,
} from "./fakes/fake-store-deps.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function until(done: () => boolean | Promise<boolean>, ms = 4_000): Promise<void> {
  for (let waited = 0; waited < ms && !(await done()); waited += 20) await sleep(20);
}

function phone(
  hub: ReturnType<typeof createFakeHub>,
  deviceName: string,
  options: { oldApp?: boolean } = {},
) {
  const node = addFakeNode(hub);
  setFakeNodeConnected({ hub, node, connected: true });
  const server = new FakeLoopbackServer();
  const pushes: { cause: string; folderId?: string }[] = [];
  const deps = fakeStoreDeps({
    hub,
    node,
    deviceName,
    server,
    onChanged: (e) => pushes.push(e as { cause: string }),
  });
  if (options.oldApp) {
    // A phone from before holding records: its writes to them are lost.
    const openOwn = deps.drives.openOwn.bind(deps.drives);
    deps.drives.openOwn = async (namespace?: string) => {
      const drive = await openOwn(namespace);
      const put = drive.put.bind(drive);
      drive.put = async (path: string, body: Uint8Array, opts?: Parameters<Drive["put"]>[2]) => {
        if (path.startsWith("/holding.json") || path.startsWith("/held/")) return;
        return put(path, body, opts);
      };
      return drive;
    };
  }
  mkdirSync(deps.cacheDir, { recursive: true });
  return { deps, server, pushes, store: createPhotoStore(deps) };
}

async function album(options: { viewer?: boolean; oldApp?: boolean } = {}) {
  const hub = createFakeHub();
  const anna = phone(hub, "Anna");
  const nils = phone(hub, "Nils", { oldApp: options.oldApp });
  await anna.store.ready();
  await nils.store.ready();
  const created = await anna.store.createFolder("Trip");
  const folderId = created[1]!.folder.id;
  const shareKey = created[1]!.folder.shareKey;
  const nilsKey = await joinAsMember(anna.store, folderId, nils.store, shareKey);
  if (options.viewer) expect((await anna.store.makeViewer(folderId, nilsKey))[0]).toBeNull();
  const nilsFolderId = (await nils.store.folders()).folders.find(
    (f) => f.shareKey === shareKey,
  )!.id;
  await nils.store.setActive(nilsFolderId);
  await anna.store.setActive(folderId);
  await anna.store.addBytes("sunset.jpg", new Uint8Array([1, 2, 3, 4, 5]));
  const annaPhoto = async () => (await anna.store.list()).find((p) => p.name === "sunset.jpg")!;
  const nilsPhoto = async () =>
    (await nils.store.list(nilsFolderId)).find((p) => p.name === "sunset.jpg");
  await until(async () => (await nilsPhoto()) !== undefined);
  const close = async () => {
    await anna.store.close();
    await nils.store.close();
  };
  return { hub, anna, nils, folderId, nilsFolderId, nilsKey, annaPhoto, nilsPhoto, close };
}

describe("who has each photo", () => {
  it("the adder's phone holds it and nobody else does yet", async () => {
    const s = await album();
    const holders = (await s.annaPhoto()).holders!;
    expect(holders.here).toBe(true);
    expect(holders.others).toEqual([]);
    expect(holders.unsure).toEqual([]);
    await s.close();
  });

  it("another phone sees the adder as a holder before it opens the photo", async () => {
    const s = await album();
    const holders = (await s.nilsPhoto())!.holders!;
    expect(holders.here).toBe(false);
    expect(holders.others.map((m: { key: string; name: string }) => m.name)).toEqual(["Anna"]);
    expect(holders.unsure).toEqual([]);
    await s.close();
  });

  it("opening the photo makes the phone a holder and tells the adder", async () => {
    const s = await album();
    const photo = (await s.nilsPhoto())!;
    const before = s.anna.pushes.filter((p) => p.cause === "holders").length;
    expect((await s.nils.server.getForTest(new URL(photo.url).pathname)).status).toBe(200);
    await until(async () => (await s.nilsPhoto())!.holders!.here);
    expect((await s.nilsPhoto())!.holders!.here).toBe(true);
    await until(async () => (await s.annaPhoto()).holders!.others.length === 1);
    expect(
      (await s.annaPhoto()).holders!.others.map((m: { key: string; name: string }) => m.key),
    ).toEqual([s.nilsKey]);
    expect(s.anna.pushes.filter((p) => p.cause === "holders").length).toBeGreaterThan(before);
    await s.close();
  });

  it("a Viewer's phone is a holder once it opens the photo", async () => {
    const s = await album({ viewer: true });
    const photo = (await s.nilsPhoto())!;
    await s.nils.server.getForTest(new URL(photo.url).pathname);
    await until(async () => (await s.annaPhoto()).holders!.others.length === 1);
    expect(
      (await s.annaPhoto()).holders!.others.map((m: { key: string; name: string }) => m.key),
    ).toEqual([s.nilsKey]);
    await s.close();
  });

  it("a person whose phone has no record is unsure, and the adder never is", async () => {
    const s = await album({ oldApp: true });
    await s.nils.store.addBytes("nils.jpg", new Uint8Array([7, 7, 7]), s.nilsFolderId);
    await until(async () => (await s.anna.store.list()).length === 2);
    const mine = (await s.anna.store.list()).find((p) => p.name === "sunset.jpg")!;
    expect(mine.holders!.unsure.map((m: { key: string; name: string }) => m.key)).toEqual([
      s.nilsKey,
    ]);
    const theirs = (await s.anna.store.list()).find((p) => p.name === "nils.jpg")!;
    expect(theirs.holders!.others.map((m: { key: string; name: string }) => m.key)).toEqual([
      s.nilsKey,
    ]);
    expect(theirs.holders!.unsure).toEqual([]);
    await s.close();
  });

  it("opening the thumbnail alone records nothing", async () => {
    const s = await album();
    const display = join(s.anna.deps.cacheDir, "t-display.jpg");
    const thumb = join(s.anna.deps.cacheDir, "t-thumb.jpg");
    writeFileSync(display, new Uint8Array([10, 11, 12]));
    writeFileSync(thumb, new Uint8Array([20, 21]));
    await s.anna.store.add(display, "t.jpg", s.folderId, { thumb });
    await until(async () => (await s.nils.store.list(s.nilsFolderId)).length === 2);
    const photo = (await s.nils.store.list(s.nilsFolderId)).find((p) => p.name === "t.jpg")!;
    expect(photo.thumbUrl).toBeDefined();
    await s.nils.server.getForTest(new URL(photo.thumbUrl!).pathname);
    await sleep(300);
    const after = (await s.nils.store.list(s.nilsFolderId)).find((p) => p.name === "t.jpg")!;
    expect(after.holders!.here).toBe(false);
    await s.nils.server.getForTest(new URL(photo.url).pathname);
    await until(
      async () =>
        (await s.nils.store.list(s.nilsFolderId)).find((p) => p.name === "t.jpg")!.holders!.here,
    );
    await s.close();
  });

  it("records a copy that was opened before this version", async () => {
    const s = await album();
    const photo = (await s.nilsPhoto())!;
    await s.nils.store.close();
    const spool = join(
      s.nils.deps.cacheDir,
      "photos",
      s.nilsFolderId,
      spoolNameFor(photo.member.key, photo.id, ".jpg"),
    );
    mkdirSync(join(s.nils.deps.cacheDir, "photos", s.nilsFolderId), { recursive: true });
    writeFileSync(spool, new Uint8Array([1, 2, 3, 4, 5]));
    const reopened = createPhotoStore(restarted(s.nils.deps));
    await reopened.ready();
    await reopened.list(s.nilsFolderId);
    await until(async () => (await s.annaPhoto()).holders!.others.length === 1);
    expect(
      (await s.annaPhoto()).holders!.others.map((m: { key: string; name: string }) => m.key),
    ).toEqual([s.nilsKey]);
    await reopened.close();
    await s.anna.store.close();
  });

  it("keeps a phone's record after Remove moves the album", async () => {
    const hub = createFakeHub();
    const anna = phone(hub, "Anna");
    const nils = phone(hub, "Nils");
    const ben = phone(hub, "Ben");
    for (const p of [anna, nils, ben]) await p.store.ready();
    const created = await anna.store.createFolder("Trip");
    const folderId = created[1]!.folder.id;
    const shareKey = created[1]!.folder.shareKey;
    await joinAsMember(anna.store, folderId, nils.store, shareKey);
    const benKey = await joinAsMember(anna.store, folderId, ben.store, shareKey);
    const nilsFolder = (await nils.store.folders()).folders.find((f) => f.shareKey === shareKey)!;
    await nils.store.setActive(nilsFolder.id);
    await anna.store.setActive(folderId);
    await anna.store.addBytes("sunset.jpg", new Uint8Array([1, 2, 3, 4, 5]));
    await until(async () => (await nils.store.list(nilsFolder.id)).length === 1);
    const photo = (await nils.store.list(nilsFolder.id))[0];
    await nils.server.getForTest(new URL(photo.url).pathname);
    await until(async () => (await anna.store.list())[0].holders!.others.length === 1);

    expect((await anna.store.removeMember(folderId, benKey))[0]).toBeNull();
    await until(async () => {
      const now = (await anna.store.folders()).folders.find((f) => f.id === folderId)!;
      return now.shareKey !== shareKey;
    });
    await until(async () => (await anna.store.list(folderId))[0]?.holders?.others.length === 1);
    const holders = (await anna.store.list(folderId))[0].holders!;
    expect(holders.others).toHaveLength(1);
    for (const p of [anna, nils, ben]) await p.store.close();
  });
});
