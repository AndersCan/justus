/**
 * Phones record the photos they hold a full copy of and read each other's
 * records, so every listed photo says who has it. Phones share one hub on the
 * checked fakes.
 */
import { describe, it, expect, vi } from "vite-plus/test";
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

function watched(
  deps: ReturnType<typeof fakeStoreDeps>,
  heldPuts: string[],
  quiet: {
    on: boolean;
    previews: boolean;
    delFails: boolean;
    slowHeldMs?: number;
    dels?: string[];
  },
) {
  {
    const openOwn = deps.drives.openOwn.bind(deps.drives);
    deps.drives.openOwn = async (namespace?: string) => {
      const drive = await openOwn(namespace);
      const del = drive.del.bind(drive);
      drive.del = async (path: string, ...rest: unknown[]) => {
        if (quiet.delFails && path.startsWith("/held/")) throw new Error("disk full");
        quiet.dels?.push(path);
        return (del as (...a: unknown[]) => Promise<void>)(path, ...rest);
      };
      const put = drive.put.bind(drive);
      drive.put = async (path: string, body: Uint8Array, opts?: Parameters<Drive["put"]>[2]) => {
        if (path.startsWith("/held/")) {
          heldPuts.push(path);
          // A Hyperdrive put appends the blob before the entry: a later del can land first.
          await sleep(quiet.slowHeldMs ?? 60);
        }
        if (path.startsWith("/previewed/") && quiet.slowHeldMs) await sleep(quiet.slowHeldMs);
        return put(path, body, opts);
      };
      return drive;
    };
    // Other phones' records stop answering while `quiet.on` is set.
    const open = deps.drives.open.bind(deps.drives);
    deps.drives.open = async (...args: Parameters<typeof open>) => {
      const result = await open(...args);
      const drive = result[1];
      if (!drive) return result;
      const list = drive.list.bind(drive);
      drive.list = (dir: string) =>
        quiet.previews && dir === "/previewed"
          ? { [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }) }
          : list(dir);
      const readSmall = drive.readSmall.bind(drive);
      drive.readSmall = async (...a: Parameters<Drive["readSmall"]>) => {
        if (quiet.on && a[0] === "/holding.json") throw new Error("unreachable");
        return readSmall(...a);
      };
      return result;
    };
  }
  return deps;
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
    log: (e: { event: string; fields: Record<string, unknown> }) => logs.push(e),
  });
  const heldPuts: string[] = [];
  const quiet: {
    on: boolean;
    previews: boolean;
    delFails: boolean;
    slowHeldMs?: number;
    dels?: string[];
  } = { on: false, previews: false, delFails: false };
  const logs: { event: string; fields: Record<string, unknown> }[] = [];
  watched(deps, heldPuts, quiet);
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
  return { deps, server, pushes, heldPuts, quiet, logs, store: createPhotoStore(deps) };
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
  const annaPhotoNamed = async (name: string) =>
    (await anna.store.list()).find((p) => p.name === name)!;
  const annaPhoto = async () => (await anna.store.list()).find((p) => p.name === "sunset.jpg")!;
  const nilsPhoto = async () =>
    (await nils.store.list(nilsFolderId)).find((p) => p.name === "sunset.jpg");
  await until(async () => (await nilsPhoto()) !== undefined);
  const close = async () => {
    await anna.store.close();
    await nils.store.close();
  };
  return {
    hub,
    anna,
    nils,
    folderId,
    nilsFolderId,
    nilsKey,
    annaPhoto,
    annaPhotoNamed,
    nilsPhoto,
    close,
  };
}

type Album = Awaited<ReturnType<typeof album>>;

/** Anna adds a photo with a thumbnail; returns Nils's view of it. */
async function addThumbed(s: Album, name: string) {
  const display = join(s.anna.deps.cacheDir, `${name}-display.jpg`);
  const thumb = join(s.anna.deps.cacheDir, `${name}-thumb.jpg`);
  writeFileSync(display, new Uint8Array([10, 11, 12]));
  writeFileSync(thumb, new Uint8Array([20, 21]));
  const count = (await s.nils.store.list(s.nilsFolderId)).length;
  await s.anna.store.add(display, name, s.folderId, { thumb });
  await until(async () => (await s.nils.store.list(s.nilsFolderId)).length === count + 1);
  return (await s.nils.store.list(s.nilsFolderId)).find((p) => p.name === name)!;
}

const previewKeys = async (s: Album, name: string) =>
  (await s.annaPhotoNamed(name)).holders!.previews.map((m: { key: string }) => m.key);
const fullKeys = async (s: Album, name: string) =>
  (await s.annaPhotoNamed(name)).holders!.others.map((m: { key: string }) => m.key);

describe("a phone with a full copy and a preview of different photos", () => {
  it("a preview of one photo keeps the full copy of another", async () => {
    const s = await album();
    await s.nils.server.getForTest(new URL((await s.nilsPhoto())!.url).pathname);
    await until(async () => (await s.nilsPhoto())!.holders!.here);
    const k = await addThumbed(s, "k.jpg");
    await s.nils.server.getForTest(new URL(k.thumbUrl!).pathname);
    await until(async () => (await previewKeys(s, "k.jpg")).length === 1);
    expect((await s.nilsPhoto())!.holders!.here).toBe(true);
    expect(await fullKeys(s, "sunset.jpg")).toEqual([s.nilsKey]);
    await s.close();
  });

  it("a full copy of one photo keeps the preview of another", async () => {
    const s = await album();
    const k = await addThumbed(s, "k.jpg");
    await s.nils.server.getForTest(new URL(k.thumbUrl!).pathname);
    await until(async () => (await previewKeys(s, "k.jpg")).length === 1);
    await s.nils.server.getForTest(new URL((await s.nilsPhoto())!.url).pathname);
    await until(async () => (await fullKeys(s, "sunset.jpg")).length === 1);
    expect(await previewKeys(s, "k.jpg")).toEqual([s.nilsKey]);
    await s.close();
  });

  it("a preview does not replace a full copy of the same photo", async () => {
    const s = await album();
    const k = await addThumbed(s, "k.jpg");
    await s.nils.server.getForTest(new URL(k.url).pathname);
    await until(async () => (await fullKeys(s, "k.jpg")).length === 1);
    await s.nils.server.getForTest(new URL(k.thumbUrl!).pathname);
    await sleep(400);
    expect(await previewKeys(s, "k.jpg")).toEqual([]);
    expect(await fullKeys(s, "k.jpg")).toEqual([s.nilsKey]);
    // Nothing was written to the phone's own preview list either.
    const drive = (await s.anna.deps.drives.open(s.nilsKey, { timeoutMs: 1_000 }))[1]!;
    const listed: string[] = [];
    for await (const entry of drive.list("/previewed")) listed.push(entry.path);
    expect(listed).toEqual([]);
    await s.close();
  });

  it("keeps known previews when the previews list is slow", async () => {
    const s = await album();
    const k = await addThumbed(s, "k.jpg");
    await s.nils.server.getForTest(new URL(k.thumbUrl!).pathname);
    await until(async () => (await previewKeys(s, "k.jpg")).length === 1);
    s.anna.quiet.previews = true;
    await s.nils.store.addBytes("more.jpg", new Uint8Array([9, 9]), s.nilsFolderId);
    await until(async () => (await s.anna.store.list()).length === 3);
    await sleep(2_200);
    expect(await previewKeys(s, "k.jpg")).toEqual([s.nilsKey]);
    expect((await s.annaPhotoNamed("k.jpg")).holders!.waiting).toEqual([]);
    await s.close();
  }, 20_000);

  it("backfill keeps a full copy and a preview of different photos", async () => {
    const s = await album();
    const sun = (await s.nilsPhoto())!;
    const k = await addThumbed(s, "k.jpg");
    await s.anna.store.addBytes("moon.jpg", new Uint8Array([6, 6]));
    await until(async () => (await s.nils.store.list(s.nilsFolderId)).length === 3);
    const moon = (await s.nils.store.list(s.nilsFolderId)).find((p) => p.name === "moon.jpg")!;
    await s.nils.store.close();
    const dir = join(s.nils.deps.cacheDir, "photos", s.nilsFolderId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, spoolNameFor(sun.member.key, sun.id, ".jpg")), new Uint8Array([1]));
    writeFileSync(join(dir, spoolNameFor(moon.member.key, moon.id, ".jpg")), new Uint8Array([1]));
    writeFileSync(join(dir, spoolNameFor(k.member.key, k.id, "thumb.jpg")), new Uint8Array([2]));
    const reopened = createPhotoStore(restarted(s.nils.deps));
    await reopened.ready();
    await reopened.list(s.nilsFolderId);
    await until(async () => (await previewKeys(s, "k.jpg")).length === 1);
    await until(async () => (await fullKeys(s, "sunset.jpg")).length === 1);
    await until(async () => (await fullKeys(s, "moon.jpg")).length === 1);
    expect(await previewKeys(s, "k.jpg")).toEqual([s.nilsKey]);
    const mine = await reopened.list(s.nilsFolderId);
    expect(mine.map((p) => [p.name, p.holders!.here]).sort()).toEqual([
      ["k.jpg", false],
      ["moon.jpg", true],
      ["sunset.jpg", true],
    ]);
    await reopened.close();
    await s.anna.store.close();
  }, 20_000);

  it("a backfilled preview alone pushes a holders change", async () => {
    const s = await album();
    const k = await addThumbed(s, "k.jpg");
    await s.nils.store.close();
    const dir = join(s.nils.deps.cacheDir, "photos", s.nilsFolderId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, spoolNameFor(k.member.key, k.id, "thumb.jpg")), new Uint8Array([2]));
    const pushes: { cause: string }[] = [];
    const reopened = createPhotoStore({
      ...restarted(s.nils.deps),
      onChanged: (e) => pushes.push(e as { cause: string }),
    });
    await reopened.ready();
    await sleep(1_500);
    const before = pushes.filter((e) => e.cause === "holders").length;
    await reopened.list(s.nilsFolderId);
    await until(async () => (await previewKeys(s, "k.jpg")).length === 1);
    await sleep(200);
    expect(pushes.filter((e) => e.cause === "holders").length).toBeGreaterThan(before);
    await reopened.close();
    await s.anna.store.close();
  }, 20_000);
});

describe("who has each photo", () => {
  it("the adder's phone holds it and nobody else does yet", async () => {
    const s = await album();
    const holders = (await s.annaPhoto()).holders!;
    expect(holders.here).toBe(true);
    expect(holders.others).toEqual([]);
    expect(holders.unsure).toEqual([]);
    await until(async () => (await s.annaPhoto()).holders!.waiting.length === 1);
    expect(
      (await s.annaPhoto()).holders!.waiting.map((m: { key: string; name: string }) => m.key),
    ).toEqual([s.nilsKey]);
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
    expect((await s.annaPhoto()).holders!.waiting).toEqual([]);
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

  it("opening the thumbnail alone records a preview", async () => {
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
    await until(async () => (await s.annaPhotoNamed("t.jpg")).holders!.previews.length === 1);
    const seen = (await s.annaPhotoNamed("t.jpg")).holders!;
    expect(seen.previews.map((m: { key: string }) => m.key)).toEqual([s.nilsKey]);
    expect(seen.waiting).toEqual([]);
    expect(seen.others.map((m: { key: string }) => m.key)).not.toContain(s.nilsKey);
    await s.nils.server.getForTest(new URL(photo.url).pathname);
    await until(
      async () =>
        (await s.nils.store.list(s.nilsFolderId)).find((p) => p.name === "t.jpg")!.holders!.here,
    );
    await until(async () => (await s.annaPhotoNamed("t.jpg")).holders!.previews.length === 0);
    const full = (await s.annaPhotoNamed("t.jpg")).holders!;
    expect(full.others.map((m: { key: string }) => m.key)).toContain(s.nilsKey);
    await s.close();
  });

  it("records a preview that was spooled before this version", async () => {
    const s = await album();
    const display = join(s.anna.deps.cacheDir, "o-display.jpg");
    const thumb = join(s.anna.deps.cacheDir, "o-thumb.jpg");
    writeFileSync(display, new Uint8Array([10, 11, 12]));
    writeFileSync(thumb, new Uint8Array([20, 21]));
    await s.anna.store.add(display, "o.jpg", s.folderId, { thumb });
    await until(async () => (await s.nils.store.list(s.nilsFolderId)).length === 2);
    const photo = (await s.nils.store.list(s.nilsFolderId)).find((p) => p.name === "o.jpg")!;
    await s.nils.store.close();
    mkdirSync(join(s.nils.deps.cacheDir, "photos", s.nilsFolderId), { recursive: true });
    writeFileSync(
      join(
        s.nils.deps.cacheDir,
        "photos",
        s.nilsFolderId,
        spoolNameFor(photo.member.key, photo.id, "thumb.jpg"),
      ),
      new Uint8Array([20, 21]),
    );
    const reopened = createPhotoStore(restarted(s.nils.deps));
    await reopened.ready();
    await reopened.list(s.nilsFolderId);
    await until(async () => (await s.annaPhotoNamed("o.jpg")).holders!.previews.length === 1);
    expect(
      (await s.annaPhotoNamed("o.jpg")).holders!.previews.map((m: { key: string }) => m.key),
    ).toEqual([s.nilsKey]);
    // A photo with nothing spooled is not a preview.
    expect((await s.annaPhoto()).holders!.previews).toEqual([]);
    await reopened.close();
    await s.anna.store.close();
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

  async function viewerOpensAfter(readAgain: boolean) {
    const s = await album();
    const sunset = await s.nilsPhoto();
    await s.nils.server.getForTest(new URL(sunset!.url).pathname);
    const others = async (p: typeof s.anna, name: string) =>
      (await p.store.list())
        .find((x) => x.name === name)
        ?.holders?.others.map((o: { key: string }) => o.key);
    await until(async () => (await others(s.anna, "sunset.jpg"))?.includes(s.nilsKey) === true);
    const kim = phone(s.hub, "Kim");
    await kim.store.ready();
    const shareKey = (await s.anna.store.folders()).folders.find(
      (f) => f.id === s.folderId,
    )!.shareKey;
    await joinAsMember(s.anna.store, s.folderId, kim.store, shareKey);
    const kimFolder = (await kim.store.folders()).folders.find((f) => f.shareKey === shareKey)!;
    await kim.store.setActive(kimFolder.id);
    await until(async () => (await kim.store.list(kimFolder.id)).length === 1);
    expect((await s.anna.store.makeViewer(s.folderId, s.nilsKey))[0]).toBeNull();

    await s.anna.store.addBytes("late.jpg", new Uint8Array([9, 9, 9, 9]));
    const nilsLate = async () =>
      (await s.nils.store.list(s.nilsFolderId)).find((x) => x.name === "late.jpg");
    await until(async () => (await nilsLate()) !== undefined);
    await s.nils.server.getForTest(new URL((await nilsLate())!.url).pathname);

    await until(async () => (await others(kim, "late.jpg")) !== undefined, 15_000);
    await until(
      async () =>
        (await others(kim, "late.jpg"))?.includes(s.nilsKey) === true &&
        (await others(s.anna, "late.jpg"))?.includes(s.nilsKey) === true,
      8_000,
    );
    const ben = readAgain ? phone(s.hub, "Ben") : undefined;
    if (ben) {
      // Another person becoming a Viewer makes every phone read its records again.
      await ben.store.ready();
      const benKey = await joinAsMember(s.anna.store, s.folderId, ben.store, shareKey);
      await until(async () =>
        ((await s.anna.store.status()).members as { key: string }[]).some((m) => m.key === benKey),
      );
      expect((await s.anna.store.makeViewer(s.folderId, benKey))[0]).toBeNull();
      await sleep(1_500);
    }
    const waiting = async (p: typeof s.anna, name: string) =>
      (await p.store.list())
        .find((x) => x.name === name)
        ?.holders?.waiting.map((o: { key: string }) => o.key);

    expect(await others(kim, "late.jpg")).toContain(s.nilsKey);
    expect(await waiting(kim, "late.jpg")).not.toContain(s.nilsKey);
    expect(await others(kim, "sunset.jpg")).toContain(s.nilsKey);
    expect(await others(s.anna, "late.jpg")).toEqual([s.nilsKey]);
    expect(await waiting(s.anna, "late.jpg")).not.toContain(s.nilsKey);
    await ben?.store.close();
    await kim.store.close();
    await s.close();
  }

  it(
    "a Collaborator made a Viewer counts for the photos they open after, on every phone",
    () => viewerOpensAfter(false),
    30_000,
  );

  it(
    "a Viewer's count stays when another person becomes a Viewer",
    () => viewerOpensAfter(true),
    30_000,
  );

  it("backfill skips a photo that was never opened", async () => {
    const s = await album();
    await s.nils.store.close();
    const reopened = createPhotoStore(restarted(s.nils.deps));
    await reopened.ready();
    await reopened.list(s.nilsFolderId);
    await sleep(500);
    expect((await s.annaPhoto()).holders!.others).toEqual([]);
    await reopened.close();
    await s.anna.store.close();
  });

  it("backfill never records the phone's own photos", async () => {
    const s = await album();
    const photo = await s.annaPhoto();
    await s.anna.store.close();
    mkdirSync(join(s.anna.deps.cacheDir, "photos", s.folderId), { recursive: true });
    writeFileSync(
      join(
        s.anna.deps.cacheDir,
        "photos",
        s.folderId,
        spoolNameFor(photo.member.key, photo.id, ".jpg"),
      ),
      new Uint8Array([1, 2, 3, 4, 5]),
    );
    const again = restarted(s.anna.deps);
    const reopened = createPhotoStore(again);
    await reopened.ready();
    await sleep(300);
    expect((await reopened.list(s.folderId)).map((p) => p.name)).toEqual(["sunset.jpg"]);
    await sleep(2200);
    const own = await again.drives.openOwn(`folder/${s.folderId}`);
    const held: string[] = [];
    for await (const e of own.list("/held")) held.push(e.path);
    expect(held).toEqual([]);
    await reopened.close();
    await s.nils.store.close();
  });

  it("opening a photo twice writes its record once", async () => {
    const s = await album();
    const photo = (await s.nilsPhoto())!;
    const route = new URL(photo.url).pathname;
    await Promise.all([
      s.nils.server.getForTest(route),
      s.nils.server.getForTest(route),
      s.nils.server.getForTest(route),
    ]);
    await until(async () => (await s.nilsPhoto())!.holders!.here);
    await s.nils.server.getForTest(route);
    await sleep(300);
    expect(s.nils.heldPuts.filter((p) => p === `/held/${photo.id}`)).toHaveLength(1);
    await s.close();
  });

  it("a phone whose record cannot be read keeps its earlier report", async () => {
    const s = await album();
    const photo = (await s.nilsPhoto())!;
    await s.nils.server.getForTest(new URL(photo.url).pathname);
    await until(async () => (await s.annaPhoto()).holders!.others.length === 1);
    s.anna.quiet.on = true;
    await s.nils.store.addBytes("more.jpg", new Uint8Array([9, 9]), s.nilsFolderId);
    await until(async () => (await s.anna.store.list()).length === 2);
    await sleep(800);
    const holders = (await s.anna.store.list()).find((p) => p.name === "sunset.jpg")!.holders!;
    expect(holders.others.map((m: { key: string }) => m.key)).toEqual([s.nilsKey]);
    expect(holders.unsure).toEqual([]);
    await s.close();
  });

  it("an unchanged record read again pushes nothing", async () => {
    const s = await album();
    const photo = (await s.nilsPhoto())!;
    await s.nils.server.getForTest(new URL(photo.url).pathname);
    await until(async () => (await s.annaPhoto()).holders!.others.length === 1);
    await sleep(500);
    const before = s.anna.pushes.filter((p) => p.cause === "holders").length;
    await s.nils.store.addBytes("more.jpg", new Uint8Array([9, 9]), s.nilsFolderId);
    await until(async () => (await s.anna.store.list()).length === 2);
    await sleep(800);
    expect(s.anna.pushes.filter((p) => p.cause === "holders").length).toBe(before);
    await s.close();
  });

  it("a member sees the Admin's record without the Admin's photo being opened", async () => {
    const s = await album();
    const holders = (await s.nilsPhoto())!.holders!;
    expect(holders.others.map((m: { name: string }) => m.name)).toEqual(["Anna"]);
    await s.close();
  });

  it("a restarted member reads the Admin's record straight away", async () => {
    const s = await album();
    await s.nils.store.addBytes("nils.jpg", new Uint8Array([7, 7, 7]), s.nilsFolderId);
    await until(async () => (await s.anna.store.list()).length === 2);
    const theirs = (await s.anna.store.list()).find((p) => p.name === "nils.jpg")!;
    await s.anna.server.getForTest(new URL(theirs.url).pathname);
    await until(
      async () => (await s.anna.store.list()).find((p) => p.name === "nils.jpg")!.holders!.here,
    );
    await s.nils.store.close();
    const reopened = createPhotoStore(restarted(s.nils.deps));
    await reopened.ready();
    await until(async () => {
      const mine = (await reopened.list(s.nilsFolderId)).find((p) => p.name === "nils.jpg");
      return (mine?.holders?.others.length ?? 0) === 1;
    });
    const mine = (await reopened.list(s.nilsFolderId)).find((p) => p.name === "nils.jpg")!;
    expect(mine.holders!.others.map((m: { name: string }) => m.name)).toEqual(["Anna"]);
    await reopened.close();
    await s.anna.store.close();
  });

  it("a restarted phone lists the Admin as quiet when it last had him 4 days ago", async () => {
    const s = await album();
    const adminKey = (await s.nilsPhoto())!.holders!.others[0]!.key;
    await s.close();
    const at = Date.now() - 4 * 24 * 60 * 60 * 1000;
    writeFileSync(
      join(s.nils.deps.storageDir, "presence.json"),
      JSON.stringify({ [adminKey]: at }),
    );
    const reopened = createPhotoStore(restarted(s.nils.deps));
    await reopened.ready();
    const first = (await reopened.list(s.nilsFolderId)).find((p) => p.name === "sunset.jpg")!;
    expect(first.holders).toMatchObject({
      kind: "inAlbum",
      others: [],
      quiet: [{ key: adminKey, name: "Anna", lastSeenAt: at }],
    });
    await reopened.close();
  });

  it("a quiet Admin is back in has-it once the phones meet again", async () => {
    const s = await album();
    const adminKey = (await s.nilsPhoto())!.holders!.others[0]!.key;
    await s.nils.store.close();
    const at = Date.now() - 4 * 24 * 60 * 60 * 1000;
    writeFileSync(
      join(s.nils.deps.storageDir, "presence.json"),
      JSON.stringify({ [adminKey]: at }),
    );
    const deps = restarted(s.nils.deps);
    const pushes: { cause: string }[] = [];
    const reopened = createPhotoStore({
      ...deps,
      onChanged: (e) => pushes.push(e as { cause: string }),
    });
    await reopened.ready();
    await until(async () => {
      const p = (await reopened.list(s.nilsFolderId)).find((x) => x.name === "sunset.jpg");
      return p?.holders?.kind === "inAlbum" && p.holders.others.length === 1;
    });
    expect(pushes.some((p) => p.cause === "holders")).toBe(true);
    const back = (await reopened.list(s.nilsFolderId)).find((p) => p.name === "sunset.jpg")!;
    expect(back.holders).toMatchObject({ kind: "inAlbum", quiet: [] });
    expect(back.holders!.kind === "inAlbum" && back.holders!.others).toEqual([
      expect.not.objectContaining({ lastSeenAt: expect.anything() }),
    ]);
    expect(back.holders!.kind === "inAlbum" && back.holders!.others[0]!.key).toBe(adminKey);
    await reopened.close();
    await s.anna.store.close();
  });

  it("two listings started together both carry holders", async () => {
    const s = await album();
    await s.nils.store.close();
    const slow = restarted(s.nils.deps);
    const openOwn = slow.drives.openOwn.bind(slow.drives);
    slow.drives.openOwn = async (namespace?: string) => {
      const drive = await openOwn(namespace);
      const list = drive.list.bind(drive);
      drive.list = (dir: string) => {
        const inner = list(dir);
        return {
          [Symbol.asyncIterator]: () => {
            const it = inner[Symbol.asyncIterator]();
            return {
              next: async () => {
                await sleep(300);
                return it.next();
              },
              return: async (v?: unknown) => it.return?.(v) ?? { done: true as const, value: v },
            };
          },
        } as ReturnType<typeof list>;
      };
      return drive;
    };
    const reopened = createPhotoStore(slow);
    await reopened.ready();
    const [first, second] = await Promise.all([
      reopened.list(s.nilsFolderId),
      reopened.list(s.nilsFolderId),
    ]);
    expect(first.every((p) => p.holders !== undefined)).toBe(true);
    expect(second.every((p) => p.holders !== undefined)).toBe(true);
    await reopened.close();
    await s.anna.store.close();
  });

  it("the first list after a restart says previewHere for a preview recorded before", async () => {
    const s = await album();
    const photo = await addThumbed(s, "pv.jpg");
    await s.nils.server.getForTest(new URL(photo.thumbUrl!).pathname);
    await until(async () => (await s.annaPhotoNamed("pv.jpg")).holders!.previews.length === 1);
    await s.nils.store.close();
    const reopened = createPhotoStore(restarted(s.nils.deps));
    await reopened.ready();
    const first = (await reopened.list(s.nilsFolderId)).find((p) => p.name === "pv.jpg")!;
    expect(first.holders).toMatchObject({ kind: "inAlbum", here: false, previewHere: true });
    await reopened.close();
    await s.anna.store.close();
  });

  it("two listings started together read the own record once", async () => {
    const s = await album();
    await s.nils.store.close();
    const deps = restarted(s.nils.deps);
    let markerReads = 0;
    const openOwn = deps.drives.openOwn.bind(deps.drives);
    deps.drives.openOwn = async (namespace?: string) => {
      const drive = await openOwn(namespace);
      const readSmall = drive.readSmall.bind(drive);
      drive.readSmall = async (...args: Parameters<Drive["readSmall"]>) => {
        if (args[0] === "/holding.json") {
          markerReads++;
          await sleep(300);
        }
        return readSmall(...args);
      };
      return drive;
    };
    const reopened = createPhotoStore(deps);
    await reopened.ready();
    await Promise.all([reopened.list(s.nilsFolderId), reopened.list(s.nilsFolderId)]);
    await sleep(700);
    // Two reads in all: the marker check plus one record read, shared by both listings.
    expect(markerReads).toBe(2);
    await reopened.close();
    await s.anna.store.close();
  });

  it("a phone whose own record cannot be read lists photos without holders", async () => {
    const s = await album();
    await s.nils.store.close();
    const deps = restarted(s.nils.deps);
    const openOwn = deps.drives.openOwn.bind(deps.drives);
    deps.drives.openOwn = async (namespace?: string) => {
      const drive = await openOwn(namespace);
      const readSmall = drive.readSmall.bind(drive);
      drive.readSmall = async (...args: Parameters<Drive["readSmall"]>) => {
        if (args[0] === "/holding.json") throw new Error("unreadable");
        return readSmall(...args);
      };
      return drive;
    };
    const reopened = createPhotoStore(deps);
    await reopened.ready();
    const photos = await reopened.list(s.nilsFolderId);
    expect(photos.length).toBeGreaterThan(0);
    expect(photos.every((p) => p.holders === undefined)).toBe(true);
    await reopened.close();
    await s.anna.store.close();
  });

  it("opening a Viewer's drive reads the record it already has", async () => {
    const s = await album({ viewer: true });
    const photo = (await s.nilsPhoto())!;
    await s.nils.server.getForTest(new URL(photo.url).pathname);
    await until(async () => (await s.annaPhoto()).holders!.others.length === 1);
    await s.anna.store.close();
    const reopened = createPhotoStore(restarted(s.anna.deps));
    await reopened.ready();
    await until(async () => {
      const mine = (await reopened.list(s.folderId)).find((p) => p.name === "sunset.jpg");
      return (mine?.holders?.others.length ?? 0) === 1;
    });
    const mine = (await reopened.list(s.folderId)).find((p) => p.name === "sunset.jpg")!;
    expect(mine.holders!.others.map((m: { key: string }) => m.key)).toEqual([s.nilsKey]);
    await reopened.close();
    await s.nils.store.close();
  });

  it("a photo whose name is not safe to record is never recorded", async () => {
    const s = await album();
    const drive = await s.anna.deps.drives.openOwn(`folder/${s.folderId}`);
    await drive.put("/photos/odd name.jpg", new Uint8Array([4, 4]));
    await until(async () => (await s.nils.store.list(s.nilsFolderId)).length === 2);
    const sunset = (await s.nilsPhoto())!;
    const odd = (await s.nils.store.list(s.nilsFolderId)).find((p) => p.id !== sunset.id)!;
    expect((await s.nils.server.getForTest(new URL(odd.url).pathname)).status).toBe(200);
    await sleep(400);
    const after = (await s.nils.store.list(s.nilsFolderId)).find((p) => p.id === odd.id)!;
    expect(after.holders!.here).toBe(false);
    expect(s.nils.heldPuts).toEqual([]);
    await s.close();
  });

  async function threePhones() {
    const hub = createFakeHub();
    const anna = phone(hub, "Anna");
    const nils = phone(hub, "Nils");
    const cleo = phone(hub, "Cleo");
    for (const p of [anna, nils, cleo]) await p.store.ready();
    const created = await anna.store.createFolder("Trip");
    const folderId = created[1]!.folder.id;
    const shareKey = created[1]!.folder.shareKey;
    await joinAsMember(anna.store, folderId, nils.store, shareKey);
    const cleoKey = await joinAsMember(anna.store, folderId, cleo.store, shareKey);
    const nilsFolder = (await nils.store.folders()).folders.find((f) => f.shareKey === shareKey)!;
    const cleoFolder = (await cleo.store.folders()).folders.find((f) => f.shareKey === shareKey)!;
    await nils.store.setActive(nilsFolder.id);
    await cleo.store.setActive(cleoFolder.id);
    await anna.store.setActive(folderId);
    await anna.store.addBytes("sunset.jpg", new Uint8Array([1, 2, 3, 4, 5]));
    await until(async () => (await cleo.store.list(cleoFolder.id)).length === 1);
    const photo = (await cleo.store.list(cleoFolder.id))[0];
    await cleo.server.getForTest(new URL(photo.url).pathname);
    await until(async () => (await anna.store.list(folderId))[0].holders!.others.length === 1);
    await until(async () => (await nils.store.list(nilsFolder.id))[0].holders!.others.length === 2);
    const close = async () => {
      for (const p of [anna, nils, cleo]) await p.store.close();
    };
    return {
      anna,
      nils,
      cleo,
      folderId,
      nilsFolderId: nilsFolder.id,
      cleoFolderId: cleoFolder.id,
      cleoKey,
      close,
    };
  }

  it("names a removed person who still has a copy, and counts them in the line", async () => {
    const s = await threePhones();
    const before = (await s.anna.store.folders()).folders[0].driveKey;
    expect((await s.anna.store.removeMember(s.folderId, s.cleoKey))[0]).toBeNull();
    await until(async () => (await s.anna.store.list(s.folderId))[0]?.holders?.former.length === 1);
    const holders = (await s.anna.store.list(s.folderId))[0].holders!;
    expect(holders.former).toEqual(["New member"]);
    expect(holders.left).toEqual([]);
    expect(holders.others.map((m: { name: string }) => m.name)).toEqual([]);
    expect(holders.here).toBe(true);
    const moved = (await s.anna.store.folders()).folders[0].driveKey;
    const drive = await s.anna.deps.drives.openOwn(`folder/${s.folderId}/m1`);
    expect(moved).toBe(drive.key);
    const text = (await drive.readSmall("/former.json", 1_000_000))!;
    expect(text).toContain("New member");
    expect(JSON.parse(text).former[0].album).toBe(s.anna.deps.drives.discoveryKeyOf(before));
    await s.close();
  }, 20_000);

  it("names a Collaborator who left", async () => {
    const s = await threePhones();
    expect((await s.cleo.store.leaveAlbum(s.cleoFolderId))[0]).toBeNull();
    await until(async () => (await s.anna.store.list(s.folderId))[0].holders!.left.length === 1);
    const holders = (await s.anna.store.list(s.folderId))[0].holders!;
    expect(holders.former).toEqual([]);
    expect(holders.left).toEqual(["New member"]);
    expect(holders.others.map((m: { name: string }) => m.name)).toEqual([]);
    const nilsFolder = (await s.nils.store.folders()).folders[0].id;
    await until(async () => (await s.nils.store.list(nilsFolder))[0]?.holders?.left.length === 1);
    const seen = (await s.nils.store.list(nilsFolder))[0].holders!;
    expect(seen.former).toEqual([]);
    expect(seen.left).toEqual(["New member"]);
    expect(seen.others.map((m: { name: string }) => m.name)).toEqual(["Anna"]);
    await s.close();
  }, 20_000);

  it("names a Viewer whose phone says they left", async () => {
    const s = await album({ viewer: true });
    const photo = (await s.nilsPhoto())!;
    await s.nils.server.getForTest(new URL(photo.url).pathname);
    await until(async () => (await s.annaPhoto()).holders!.others.length === 1);
    const drive = (await s.nils.deps.drives.open(s.nilsKey, { timeoutMs: 1_000 }))[1]!;
    await drive.put("/left.json", Buffer.from(JSON.stringify({ version: 1, leftAt: Date.now() })));
    await until(async () => (await s.annaPhoto()).holders!.left.length === 1);
    const holders = (await s.annaPhoto()).holders!;
    expect(holders.others).toEqual([]);
    expect(holders.former).toEqual([]);
    expect(holders.left).toEqual(["New member"]);
    const members = (await s.anna.store.status()).members as { key: string }[];
    expect(members.map((m) => m.key)).not.toContain(s.nilsKey);
    await s.close();
  }, 20_000);

  it("an old left note does not drop a Viewer", async () => {
    const s = await album({ viewer: true });
    const photo = (await s.nilsPhoto())!;
    await s.nils.server.getForTest(new URL(photo.url).pathname);
    await until(async () => (await s.annaPhoto()).holders!.others.length === 1);
    const drive = (await s.nils.deps.drives.open(s.nilsKey, { timeoutMs: 1_000 }))[1]!;
    await drive.put("/left.json", Buffer.from(JSON.stringify({ version: 1, leftAt: 1 })));
    await sleep(1_000);
    expect((await s.annaPhoto()).holders!.others).toHaveLength(1);
    await s.close();
  }, 20_000);

  it("a Viewer who leaves drops off every list", async () => {
    const s = await album({ viewer: true });
    const photo = (await s.nilsPhoto())!;
    await s.nils.server.getForTest(new URL(photo.url).pathname);
    await until(async () => (await s.annaPhoto()).holders!.others.length === 1);
    expect((await s.nils.store.leaveAlbum(s.nilsFolderId))[0]).toBeNull();
    expect((await s.nils.store.folders()).folders).toEqual([]);
    const gone = () =>
      (s.nils.store.debugState() as { gone: { kind?: string; listedIn?: string }[] }).gone;
    for (const g of gone()) {
      expect(g.kind).toBe("waitingForAdminToSeeYouLeft");
      expect(g.listedIn).toBe("viewers");
    }
    await until(async () => (await s.annaPhoto()).holders!.left.length === 1);
    const holders = (await s.annaPhoto()).holders!;
    expect(holders.others).toEqual([]);
    expect(holders.former).toEqual([]);
    expect(holders.left).toEqual(["New member"]);
    const members = (await s.anna.store.status()).members as { key: string }[];
    expect(members.map((m) => m.key)).not.toContain(s.nilsKey);
    await until(async () => gone().length === 0);
    await s.close();
  }, 20_000);

  it("a Viewer who leaves while the Admin's phone is off is dropped when it comes back", async () => {
    const s = await album({ viewer: true });
    const photo = (await s.nilsPhoto())!;
    await s.nils.server.getForTest(new URL(photo.url).pathname);
    await until(async () => (await s.annaPhoto()).holders!.others.length === 1);
    await s.anna.store.close();
    expect((await s.nils.store.leaveAlbum(s.nilsFolderId))[0]).toBeNull();
    const gone = () =>
      (s.nils.store.debugState() as { gone: { kind?: string; listedIn?: string }[] }).gone;
    expect(gone().map((g) => [g.kind, g.listedIn])).toEqual([
      ["waitingForAdminToSeeYouLeft", "viewers"],
    ]);
    const reopened = createPhotoStore(restarted(s.anna.deps));
    await reopened.ready();
    await until(async () => {
      const members = (await reopened.status()).members as { key: string }[];
      return !members.some((m) => m.key === s.nilsKey);
    });
    await until(async () => gone().length === 0);
    await reopened.close();
    await s.nils.store.close();
  }, 20_000);

  it("a Collaborator made a Viewer just before leaving is dropped from the Viewers list", async () => {
    const s = await album();
    expect((await s.anna.store.makeViewer(s.folderId, s.nilsKey))[0]).toBeNull();
    expect((await s.nils.store.leaveAlbum(s.nilsFolderId))[0]).toBeNull();
    const gone = () =>
      (s.nils.store.debugState() as { gone: { kind?: string; listedIn?: string }[] }).gone;
    expect(gone().map((g) => [g.kind, g.listedIn])).toEqual([
      ["waitingForAdminToSeeYouLeft", "viewers"],
    ]);
    await until(async () => gone().length === 0);
    await s.close();
  }, 20_000);

  it("a Viewer who leaves and restarts keeps waiting on the Viewers list", async () => {
    const s = await album({ viewer: true });
    await s.anna.store.close();
    expect((await s.nils.store.leaveAlbum(s.nilsFolderId))[0]).toBeNull();
    await s.nils.store.close();
    const reopened = createPhotoStore(restarted(s.nils.deps));
    await reopened.ready();
    const gone = (reopened.debugState() as { gone: { kind?: string; listedIn?: string }[] }).gone;
    expect(gone.map((g) => [g.kind, g.listedIn])).toEqual([
      ["waitingForAdminToSeeYouLeft", "viewers"],
    ]);
    await reopened.close();
  }, 20_000);

  it("drops the name when the person is accepted again", async () => {
    const s = await threePhones();
    const shareKey = (await s.cleo.store.folders()).folders[0].shareKey;
    expect((await s.cleo.store.leaveAlbum(s.cleoFolderId))[0]).toBeNull();
    await until(async () => (await s.anna.store.list(s.folderId))[0].holders!.left.length === 1);
    const key = await joinAsMember(s.anna.store, s.folderId, s.cleo.store, shareKey);
    expect(key).toBeTruthy();
    await until(async () => (await s.anna.store.list(s.folderId))[0].holders!.left.length === 0);
    expect((await s.anna.store.list(s.folderId))[0].holders!.left).toEqual([]);
    await s.close();
  }, 20_000);

  it("drops the name when an Admin-removed person is accepted again", async () => {
    const s = await threePhones();
    const shareKey = (await s.cleo.store.folders()).folders[0].shareKey;
    expect((await s.anna.store.removeMember(s.folderId, s.cleoKey))[0]).toBeNull();
    await until(async () => (await s.anna.store.list(s.folderId))[0].holders!.former.length === 1);
    const key = await joinAsMember(s.anna.store, s.folderId, s.cleo.store, shareKey);
    expect(key).toBeTruthy();
    await until(async () => (await s.anna.store.list(s.folderId))[0].holders!.former.length === 0);
    expect((await s.anna.store.list(s.folderId))[0].holders!.former).toEqual([]);
    await s.close();
  }, 20_000);

  it("an Admin tombstoning Cleo's photo takes it out of Nils's record", async () => {
    const s = await threePhones();
    await s.cleo.store.addBytes("cleo.jpg", new Uint8Array([9, 9, 9]));
    await until(async () => (await s.nils.store.list(s.nilsFolderId)).length === 2);
    const photo = (await s.nils.store.list(s.nilsFolderId)).find((p) => p.name === "cleo.jpg")!;
    await s.nils.server.getForTest(new URL(photo.url).pathname);
    const shareKey = (await s.nils.store.folders()).folders[0]!.shareKey;
    const drive = await s.nils.deps.drives.openOwn(`member/${shareKey}`);
    const held = async () => (await drive.readSmall(`/held/${photo.id}`, 10)) !== undefined;
    await until(held);
    await until(async () => (await s.anna.store.list(s.folderId)).length === 2);
    const annaSees = (await s.anna.store.list(s.folderId)).find((p) => p.name === "cleo.jpg")!;
    expect((await s.anna.store.remove(annaSees.id))[0]).toBeNull();
    await until(async () => (await s.nils.store.list(s.nilsFolderId), !(await held())));
    expect(await held()).toBe(false);
    await s.close();
  }, 20_000);

  describe("copyDeleted from a removed phone", () => {
    const identityOf = (s: { store: { debugState(): unknown } }) =>
      (s.store.debugState() as { identityDrive: string }).identityDrive;

    /** Cleo's phone tells Anna's phone it deleted its copy of `album`; returns the answers Anna sent back. */
    async function cleoSays(s: Awaited<ReturnType<typeof threePhones>>, album: string) {
      const answers: { kind: string; album?: string }[] = [];
      const network = s.anna.deps.network;
      const sendAnswer = network.sendAnswer.bind(network);
      network.sendAnswer = ((conn: number, msg: { kind: string; album?: string }) => {
        answers.push(msg);
        return sendAnswer(conn, msg as never);
      }) as typeof network.sendAnswer;
      const annaId = identityOf(s.anna);
      const links = (
        s.cleo.store.debugState() as { connections: { conn: number; identityKey: string | null }[] }
      ).connections.filter((c) => c.identityKey === annaId);
      expect(links.length).toBeGreaterThan(0);
      for (const link of links) {
        s.cleo.deps.network.sendAnswer(link.conn, { kind: "copyDeleted", album });
      }
      await until(() => answers.some((a) => a.kind === "copyDeletedSeen"));
      return answers;
    }

    it("marks the sender as left and answers copyDeletedSeen", async () => {
      const s = await threePhones();
      const before = (await s.anna.store.folders()).folders[0].driveKey;
      const album = s.anna.deps.drives.discoveryKeyOf(before);
      expect((await s.anna.store.removeMember(s.folderId, s.cleoKey))[0]).toBeNull();
      await until(
        async () => (await s.anna.store.list(s.folderId))[0]?.holders?.former.length === 1,
      );
      const answers = await cleoSays(s, album);
      expect(answers).toContainEqual({ kind: "copyDeletedSeen", album });
      await until(
        async () => (await s.anna.store.list(s.folderId))[0].holders!.former.length === 0,
      );
      expect((await s.anna.store.list(s.folderId))[0].holders!.former).toEqual([]);
      const drive = await s.anna.deps.drives.openOwn(`folder/${s.folderId}/m1`);
      expect(await drive.readSmall("/former.json", 1_000_000)).toContain(identityOf(s.cleo));
      await s.close();
    }, 30_000);

    it("marks nobody for an album that is not this one, but still answers", async () => {
      const s = await threePhones();
      expect((await s.anna.store.removeMember(s.folderId, s.cleoKey))[0]).toBeNull();
      await until(
        async () => (await s.anna.store.list(s.folderId))[0]?.holders?.former.length === 1,
      );
      const other = "ab".repeat(32);
      const answers = await cleoSays(s, other);
      expect(answers).toContainEqual({ kind: "copyDeletedSeen", album: other });
      await sleep(300);
      expect((await s.anna.store.list(s.folderId))[0].holders!.former).toEqual(["New member"]);
      await s.close();
    }, 30_000);

    it("does not mark a sender who is still in the album", async () => {
      const s = await threePhones();
      const before = (await s.anna.store.folders()).folders[0].driveKey;
      const album = s.anna.deps.drives.discoveryKeyOf(before);
      const drive = await s.anna.deps.drives.openOwn(`folder/${s.folderId}`);
      const entry = { name: "Cleo", identity: identityOf(s.cleo), ids: ["a1"], album };
      await drive.put("/former.json", Buffer.from(JSON.stringify({ version: 1, former: [entry] })));
      const answers = await cleoSays(s, album);
      expect(answers).toContainEqual({ kind: "copyDeletedSeen", album });
      const text = (await drive.readSmall("/former.json", 1_000_000))!;
      expect(JSON.parse(text).former[0].left).toBeUndefined();
      await s.close();
    }, 30_000);
  });
});

describe("a deleted photo leaves the phone's holding record", () => {
  async function nilsRecord(s: Album) {
    const shareKey = (await s.nils.store.folders()).folders.find(
      (f) => f.id === s.nilsFolderId,
    )!.shareKey;
    const drive = await s.nils.deps.drives.openOwn(`member/${shareKey}`);
    return {
      held: async (id: string) => (await drive.readSmall(`/held/${id}`, 10)) !== undefined,
      previewed: async (id: string) =>
        (await drive.readSmall(`/previewed/${id}`, 10)) !== undefined,
    };
  }

  it("a full copy is deleted from Nils's record when Anna deletes the photo", async () => {
    const s = await album();
    const photo = (await s.nilsPhoto())!;
    await s.nils.server.getForTest(new URL(photo.url).pathname);
    await until(async () => (await s.nilsPhoto())!.holders!.here);
    const record = await nilsRecord(s);
    expect(await record.held(photo.id)).toBe(true);
    const before = s.nils.pushes.length;
    await s.anna.store.remove((await s.annaPhoto()).id);
    await until(
      async () => (await s.nils.store.list(s.nilsFolderId), !(await record.held(photo.id))),
    );
    expect(await record.held(photo.id)).toBe(false);
    const pushed = s.nils.pushes.slice(before) as {
      cause: string;
      deleted?: { photos: { held?: boolean }[] };
    }[];
    await until(() => s.nils.pushes.some((p) => p.cause === "deleted"));
    const deleted = (s.nils.pushes as typeof pushed).find((p) => p.cause === "deleted")!;
    expect(deleted.deleted!.photos[0]!.held).toBe(true);
    await s.close();
  });

  it("a preview is deleted from Nils's record when Anna deletes the photo", async () => {
    const s = await album();
    const thumbed = await addThumbed(s, "thumbed.jpg");
    await s.nils.server.getForTest(new URL(thumbed.thumbUrl!).pathname);
    const record = await nilsRecord(s);
    await until(() => record.previewed(thumbed.id));
    expect(await record.previewed(thumbed.id)).toBe(true);
    await s.anna.store.remove((await s.annaPhotoNamed("thumbed.jpg")).id);
    await until(
      async () => (await s.nils.store.list(s.nilsFolderId), !(await record.previewed(thumbed.id))),
    );
    expect(await record.previewed(thumbed.id)).toBe(false);
    await s.close();
  });

  it("a failing delete of the holding record is logged", async () => {
    const s = await album();
    const photo = (await s.nilsPhoto())!;
    await s.nils.server.getForTest(new URL(photo.url).pathname);
    const record = await nilsRecord(s);
    await until(() => record.held(photo.id));
    s.nils.quiet.delFails = true;
    await s.anna.store.remove((await s.annaPhoto()).id);
    await until(
      async () => (
        await s.nils.store.list(s.nilsFolderId),
        s.nils.logs.some((l) => l.fields.where === "holding.unmark")
      ),
    );
    expect(s.nils.logs.find((l) => l.fields.where === "holding.unmark")!.fields.err).toContain(
      "disk full",
    );
    await s.close();
  });

  it("a photo Nils kept stays in his record when another is deleted", async () => {
    const s = await album();
    await s.anna.store.addBytes("keep.jpg", new Uint8Array([7, 7, 7, 7]));
    await until(async () => (await s.nils.store.list(s.nilsFolderId)).length === 2);
    const all = await s.nils.store.list(s.nilsFolderId);
    for (const p of all) await s.nils.server.getForTest(new URL(p.url).pathname);
    const record = await nilsRecord(s);
    const keep = all.find((p) => p.name === "keep.jpg")!;
    const gone = all.find((p) => p.name === "sunset.jpg")!;
    await until(async () => (await record.held(keep.id)) && (await record.held(gone.id)));
    await s.anna.store.remove((await s.annaPhoto()).id);
    await until(
      async () => (await s.nils.store.list(s.nilsFolderId), !(await record.held(gone.id))),
    );
    expect(await record.held(keep.id)).toBe(true);
    await s.close();
  });

  it("opening the full photo of a preview-only photo afterwards does not record it", async () => {
    const s = await album();
    const thumbed = await addThumbed(s, "thumbed.jpg");
    await s.nils.server.getForTest(new URL(thumbed.thumbUrl!).pathname);
    const record = await nilsRecord(s);
    await until(() => record.previewed(thumbed.id));
    await s.anna.store.remove((await s.annaPhotoNamed("thumbed.jpg")).id);
    await until(
      async () => (await s.nils.store.list(s.nilsFolderId), !(await record.previewed(thumbed.id))),
    );
    await s.nils.server.getForTest(new URL(thumbed.url).pathname);
    await sleep(300);
    expect(await record.held(thumbed.id)).toBe(false);
    await s.close();
  });

  it("opening the preview of a photo Nils never opened afterwards does not record it", async () => {
    const s = await album();
    const thumbed = await addThumbed(s, "thumbed.jpg");
    const record = await nilsRecord(s);
    await s.anna.store.remove((await s.annaPhotoNamed("thumbed.jpg")).id);
    await until(async () => (await s.nils.store.list(s.nilsFolderId)).length === 1);
    await sleep(300);
    await s.nils.server.getForTest(new URL(thumbed.thumbUrl!).pathname);
    await sleep(300);
    expect(await record.previewed(thumbed.id)).toBe(false);
    await s.close();
  });
});

describe("a record write racing the unmark", () => {
  it("a full-copy write that started before the delete does not leave the photo recorded", async () => {
    const s = await album();
    const photo = (await s.nilsPhoto())!;
    s.nils.quiet.slowHeldMs = 1_500;
    s.nils.quiet.dels = [];
    // Nils opens the photo: the spool lands and the /held/ write starts.
    await s.nils.server.getForTest(new URL(photo.url).pathname);
    await until(() => s.nils.heldPuts.length > 0);
    // Anna deletes it while that write is still appending.
    await s.anna.store.remove((await s.annaPhoto()).id);
    await until(
      async () => (
        await s.nils.store.list(s.nilsFolderId),
        s.nils.quiet.dels!.includes(`/held/${photo.id}`)
      ),
    );
    expect(s.nils.quiet.dels).toContain(`/held/${photo.id}`);
    await sleep(2_000);
    const shareKey = (await s.nils.store.folders()).folders.find(
      (f) => f.id === s.nilsFolderId,
    )!.shareKey;
    const drive = await s.nils.deps.drives.openOwn(`member/${shareKey}`);
    expect(await drive.readSmall(`/held/${photo.id}`, 10)).toBeUndefined();
    await s.close();
  }, 20_000);

  it("a preview write that started before the delete does not leave the photo recorded", async () => {
    const s = await album();
    const thumbed = await addThumbed(s, "slow.jpg");
    s.nils.quiet.slowHeldMs = 1_500;
    s.nils.quiet.dels = [];
    await s.nils.server.getForTest(new URL(thumbed.thumbUrl!).pathname);
    await sleep(300);
    await s.anna.store.remove((await s.annaPhotoNamed("slow.jpg")).id);
    await until(
      async () => (
        await s.nils.store.list(s.nilsFolderId),
        s.nils.quiet.dels!.includes(`/previewed/${thumbed.id}`)
      ),
    );
    await sleep(2_000);
    const shareKey = (await s.nils.store.folders()).folders.find(
      (f) => f.id === s.nilsFolderId,
    )!.shareKey;
    const drive = await s.nils.deps.drives.openOwn(`member/${shareKey}`);
    expect(await drive.readSmall(`/previewed/${thumbed.id}`, 10)).toBeUndefined();
    await s.close();
  }, 20_000);
});

describe("the phone that deletes a photo hears who dropped it", () => {
  type Dropped = { cause: string; dropped?: { photoId: string; people: { key: string }[] } };
  const droppedPushes = (s: Album) =>
    (s.anna.pushes as Dropped[]).filter((p) => p.cause === "dropped");

  /** Nils's screen reloads the album, which is when his phone sees the delete. */
  const untilDropped = (s: Album, n: number) =>
    until(async () => (await s.nils.store.list(s.nilsFolderId), droppedPushes(s).length >= n));

  /** Nils's record changes after the delete, which is when Anna's phone reads it again. */
  async function nilsOpensAnother(s: Album) {
    await s.anna.store.addBytes("other.jpg", new Uint8Array([4, 4, 4, 4]));
    await until(async () =>
      (await s.nils.store.list(s.nilsFolderId)).some((p) => p.name === "other.jpg"),
    );
    const other = (await s.nils.store.list(s.nilsFolderId)).find((p) => p.name === "other.jpg")!;
    await s.nils.server.getForTest(new URL(other.url).pathname);
    await until(async () => (await s.annaPhotoNamed("other.jpg")).holders!.others.length === 1);
  }

  it("answers an unknown photo with not-found", async () => {
    const s = await album();
    const [error] = await s.anna.store.remove("nope");
    expect(error?.message).toContain("No photo nope");
    await s.close();
  });

  async function nilsOpens(s: Album, name: string) {
    const photo = (await s.nils.store.list(s.nilsFolderId)).find((p) => p.name === name)!;
    await s.nils.server.getForTest(new URL(photo.url).pathname);
    await until(async () => (await s.annaPhotoNamed(name)).holders!.others.length === 1);
  }

  it("names Nils once his record drops a photo he held", async () => {
    const s = await album();
    await nilsOpens(s, "sunset.jpg");
    const photo = await s.annaPhoto();
    await s.anna.store.remove(photo.id);
    await untilDropped(s, 1);
    await sleep(300);
    expect(droppedPushes(s)).toEqual([
      expect.objectContaining({
        folderId: s.folderId,
        dropped: { photoId: photo.id, people: [expect.objectContaining({ key: s.nilsKey })] },
      }),
    ]);
    await s.close();
  });

  it("does not wait on a quiet phone: a delete with Nils away 4 days records no watch for him", async () => {
    const s = await album();
    await nilsOpens(s, "sunset.jpg");
    await s.anna.store.close();
    const at = Date.now() - 4 * 24 * 60 * 60 * 1000;
    writeFileSync(
      join(s.anna.deps.storageDir, "presence.json"),
      JSON.stringify({ [s.nilsKey]: at }),
    );
    const pushes: Dropped[] = [];
    const reopened = createPhotoStore({
      ...restarted(s.anna.deps),
      onChanged: (e) => pushes.push(e as Dropped),
    });
    await reopened.ready();
    await reopened.setActive(s.folderId);
    let id = "";
    await until(async () => {
      const p = (await reopened.list(s.folderId)).find((x) => x.name === "sunset.jpg");
      if (p?.holders?.kind !== "inAlbum" || p.holders.quiet.length !== 1) return false;
      id = p.id;
      return true;
    });
    await reopened.remove(id);
    await s.nils.store.list(s.nilsFolderId);
    await sleep(800);
    expect(pushes.filter((p) => p.cause === "dropped")).toEqual([]);
    await reopened.close();
    await s.nils.store.close();
  });

  it("names Nils for a photo he only previewed", async () => {
    const s = await album();
    const thumbed = await addThumbed(s, "thumbed.jpg");
    await s.nils.server.getForTest(new URL(thumbed.thumbUrl!).pathname);
    await until(async () => (await previewKeys(s, "thumbed.jpg")).length === 1);
    await s.anna.store.remove(thumbed.id);
    await untilDropped(s, 1);
    expect(droppedPushes(s)[0]!.dropped!.people.map((p) => p.key)).toEqual([s.nilsKey]);
    await s.close();
  });

  it("says nothing when Nils's phone never takes it out of his record", async () => {
    const s = await album();
    await nilsOpens(s, "sunset.jpg");
    s.nils.quiet.delFails = true;
    await s.anna.store.remove((await s.annaPhoto()).id);
    await nilsOpensAnother(s);
    await until(async () => (await s.nils.store.list(s.nilsFolderId), false), 1_000);
    expect(droppedPushes(s)).toEqual([]);
    await s.close();
  });

  it("stops listening 60 s after the delete", async () => {
    const s = await album();
    await nilsOpens(s, "sunset.jpg");
    await s.anna.store.remove((await s.annaPhoto()).id);
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 61_000);
    await until(async () => (await s.nils.store.list(s.nilsFolderId), false), 1_000);
    clock.mockRestore();
    expect(droppedPushes(s)).toEqual([]);
    await s.close();
  });

  it("says nothing for a photo no phone held", async () => {
    const s = await album();
    await s.anna.store.remove((await s.annaPhoto()).id);
    await until(async () => (await s.nils.store.list(s.nilsFolderId), false), 800);
    expect(droppedPushes(s)).toEqual([]);
    await s.close();
  });

  it("says nothing about the phone that added the photo when the Admin deletes it", async () => {
    const s = await album();
    await s.nils.store.addBytes("nils.jpg", new Uint8Array([9, 9, 9, 9]));
    await until(async () => (await s.anna.store.list()).some((p) => p.name === "nils.jpg"));
    await s.anna.store.remove((await s.annaPhotoNamed("nils.jpg")).id);
    await nilsOpensAnother(s);
    await until(async () => (await s.nils.store.list(s.nilsFolderId), false), 800);
    expect(droppedPushes(s)).toEqual([]);
    await s.close();
  });

  it("tells each delete on its own", async () => {
    const s = await album();
    await s.anna.store.addBytes("two.jpg", new Uint8Array([2, 2, 2, 2]));
    await until(async () => (await s.nils.store.list(s.nilsFolderId)).length === 2);
    await nilsOpens(s, "sunset.jpg");
    await nilsOpens(s, "two.jpg").catch(() => {});
    await until(async () => (await s.annaPhotoNamed("two.jpg")).holders!.others.length === 1);
    const ids = [(await s.annaPhoto()).id, (await s.annaPhotoNamed("two.jpg")).id];
    for (const id of ids) await s.anna.store.remove(id);
    await untilDropped(s, 2);
    await sleep(300);
    expect(
      droppedPushes(s)
        .map((p) => p.dropped!.photoId)
        .sort(),
    ).toEqual([...ids].sort());
    await s.close();
  });
});

describe("the deleting phone hears every holder, on any delete path", () => {
  type Dropped = { cause: string; dropped?: { photoId: string; people: { key: string }[] } };
  const droppedKeys = (pushes: unknown[]) =>
    (pushes as Dropped[])
      .filter((p) => p.cause === "dropped")
      .flatMap((p) => p.dropped!.people.map((m) => m.key))
      .sort();

  async function withKim() {
    const s = await album();
    const kim = phone(s.hub, "Kim");
    await kim.store.ready();
    const shareKey = (await s.anna.store.folders()).folders.find(
      (f) => f.id === s.folderId,
    )!.shareKey;
    const kimKey = await joinAsMember(s.anna.store, s.folderId, kim.store, shareKey);
    const kimFolderId = (await kim.store.folders()).folders.find(
      (f) => f.shareKey === shareKey,
    )!.id;
    await kim.store.setActive(kimFolderId);
    await until(async () => (await kim.store.list(kimFolderId)).length === 1);
    return { s, kim, kimKey, kimFolderId };
  }

  async function opens(p: ReturnType<typeof phone>, name: string) {
    await until(async () => (await p.store.list()).some((x) => x.name === name), 15_000);
    const photo = (await p.store.list()).find((x) => x.name === name)!;
    await p.server.getForTest(new URL(photo.url).pathname);
  }

  it("names Kim when the Admin deletes Nils's photo she held", async () => {
    const { s, kim, kimKey, kimFolderId } = await withKim();
    await s.nils.store.addBytes("nils.jpg", new Uint8Array([7, 7, 7, 7]));
    await opens(kim, "nils.jpg");
    await until(
      async () =>
        (
          (await s.anna.store.list()).find((p) => p.name === "nils.jpg")?.holders?.others ?? []
        ).some((m: { key: string }) => m.key === kimKey),
      10_000,
    );
    expect((await s.anna.store.remove((await s.annaPhotoNamed("nils.jpg")).id))[0]).toBeNull();
    await until(async () => {
      await kim.store.list(kimFolderId);
      return droppedKeys(s.anna.pushes).length >= 1;
    }, 8_000);
    expect(droppedKeys(s.anna.pushes)).toEqual([kimKey]);
    await kim.store.close();
    await s.close();
  }, 40_000);

  it("names Nils and Kim when both held the photo", async () => {
    const { s, kim, kimKey, kimFolderId } = await withKim();
    await opens(s.nils, "sunset.jpg");
    await opens(kim, "sunset.jpg");
    await until(async () => (await s.annaPhoto()).holders!.others.length === 2);
    expect((await s.anna.store.remove((await s.annaPhoto()).id))[0]).toBeNull();
    await until(async () => {
      await s.nils.store.list(s.nilsFolderId);
      await kim.store.list(kimFolderId);
      return droppedKeys(s.anna.pushes).length >= 2;
    }, 8_000);
    expect(droppedKeys(s.anna.pushes)).toEqual([s.nilsKey, kimKey].sort());
    await kim.store.close();
    await s.close();
  }, 30_000);
});
