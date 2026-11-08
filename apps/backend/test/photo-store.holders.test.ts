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

function watched(
  deps: ReturnType<typeof fakeStoreDeps>,
  heldPuts: string[],
  quiet: { on: boolean },
) {
  {
    const openOwn = deps.drives.openOwn.bind(deps.drives);
    deps.drives.openOwn = async (namespace?: string) => {
      const drive = await openOwn(namespace);
      const put = drive.put.bind(drive);
      drive.put = async (path: string, body: Uint8Array, opts?: Parameters<Drive["put"]>[2]) => {
        if (path.startsWith("/held/")) {
          heldPuts.push(path);
          await sleep(60);
        }
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
  });
  const heldPuts: string[] = [];
  const quiet = { on: false };
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
  return { deps, server, pushes, heldPuts, quiet, store: createPhotoStore(deps) };
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
