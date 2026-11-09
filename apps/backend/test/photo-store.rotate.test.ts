/**
 * Saved state 1 → 2: every album we started moves to a new key and keeps its
 * photos; every other album becomes read-only; a newer file is left alone.
 * Real Corestore + Hyperdrive, with a version 1 `justus.json` built by hand.
 */
import { makeTmpDir } from "./tmp-dirs.ts";
import { describe, it, expect } from "vite-plus/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Corestore from "corestore";
import Hyperdrive from "hyperdrive";
import { createPhotoStore, PhotoError } from "../src/photo-store.ts";
import { copyAlbumEntries } from "../src/rotate-album.ts";
import { createHyperDriveStore } from "../src/adapters/hyper-drive-store.ts";
import { fakeStoreDeps } from "./fakes/fake-store-deps.ts";

function realDeps(storageDir: string) {
  const cacheDir = join(storageDir, "cache");
  mkdirSync(cacheDir, { recursive: true });
  const drives = createHyperDriveStore(join(storageDir, "corestore"));
  return fakeStoreDeps({
    storageDir,
    cacheDir,
    drives,
  });
}

/** Deps whose own drives fail the `nth` photo write, counted across all of them. */
function failingPut(deps: ReturnType<typeof realDeps>, nth: number) {
  let puts = 0;
  return {
    ...deps,
    drives: {
      ...deps.drives,
      async openOwn(namespace?: string) {
        const d = await deps.drives.openOwn(namespace);
        const put = d.put.bind(d);
        d.put = async (...a: Parameters<typeof put>) => {
          if (a[0].startsWith("/photos/") && ++puts === nth) throw new Error("disk full");
          return put(...a);
        };
        return d;
      },
    },
  };
}

const bytes = (s: string) => Buffer.from(s);
const meta = (name: string) => ({ addedAt: 1000, name, mime: "image/jpeg", thumb: true });

async function putPhoto(drive: any, id: string, body: string, withThumb: boolean) {
  await drive.put(`/photos/${id}.jpg`, bytes(body), { metadata: meta(`${id}.jpg`) });
  if (withThumb) await drive.put(`/thumbs/${id}.jpg`, bytes(`t-${body}`));
}

/** A version 1 install: an album we started with 3 photos, one member with 2
 * (one tombstoned), and an album someone else started. */
async function seedV1(storageDir: string, opts: { extraCreator?: boolean } = {}) {
  const cs = new Corestore(join(storageDir, "corestore"));
  const album = new Hyperdrive(cs.namespace("folder/f1"));
  const member = new Hyperdrive(cs.namespace("other-member"));
  const theirs = new Hyperdrive(cs.namespace("their-album"));
  await Promise.all([album.ready(), member.ready(), theirs.ready()]);
  const albumKey = album.key.toString("hex");
  const memberKey = member.key.toString("hex");
  const theirKey = theirs.key.toString("hex");

  await album.put("/folder.json", bytes(JSON.stringify({ version: 1, name: "Trip" })));
  await putPhoto(album, "a1", "aaa1", true);
  await putPhoto(album, "a2", "aaa22", true);
  await putPhoto(album, "a3", "aaa333", false);
  await album.put(
    "/members.json",
    bytes(
      JSON.stringify({
        version: 1,
        members: { [memberKey]: { key: memberKey, name: "Nils", addedAt: 1 } },
      }),
    ),
  );
  await album.put(
    "/removed.json",
    bytes(
      JSON.stringify({
        version: 1,
        removed: {
          [`${memberKey}:m2`]: { memberKey, removedAt: 5 },
          [`${"cd".repeat(32)}:z9`]: { memberKey: "cd".repeat(32), removedAt: 6 },
        },
      }),
    ),
  );
  await member.put("/device.json", bytes(JSON.stringify({ name: "Nils" })));
  await putPhoto(member, "m1", "mm1", false);
  await putPhoto(member, "m2", "mm22", false);
  // This device is enrolled in their album, so only the move keeps it read-only.
  const selfDrive = new Hyperdrive(cs.namespace(`member/${theirKey}`));
  await selfDrive.ready();
  const selfHex = selfDrive.key.toString("hex");
  await selfDrive.close();
  await theirs.put(
    "/members.json",
    bytes(
      JSON.stringify({
        version: 1,
        members: { [selfHex]: { key: selfHex, name: "Me", addedAt: 2 } },
      }),
    ),
  );
  await theirs.put("/device.json", bytes(JSON.stringify({ name: "Greta" })));
  await theirs.put("/folder.json", bytes(JSON.stringify({ version: 1, name: "Greta's" })));
  await putPhoto(theirs, "g1", "gg1", false);

  const extra = [];
  if (opts.extraCreator) {
    const third = new Hyperdrive(cs.namespace("folder/f3"));
    await third.ready();
    await third.put("/folder.json", bytes(JSON.stringify({ version: 1, name: "Second" })));
    await putPhoto(third, "x1", "xx1", false);
    const key = third.key.toString("hex");
    await third.close();
    extra.push({
      id: "f3",
      name: "Second",
      role: "creator",
      shareKey: key,
      driveKey: key,
      createdAt: 9,
      invite: { code: "cd".repeat(32) },
    });
  }
  const v1 = {
    name: "Me",
    activeFolderId: "f1",
    asks: [],
    folders: [
      {
        id: "f1",
        name: "Trip",
        role: "creator",
        shareKey: albumKey,
        driveKey: albumKey,
        createdAt: 7,
        invite: { code: "ab".repeat(32) },
        retiredInvites: ["ef".repeat(32)],
        retiredWhy: { ["ef".repeat(32)]: "turnedOff" },
      },
      {
        id: "f2",
        name: "Greta's",
        role: "member",
        shareKey: theirKey,
        driveKey: "",
        createdAt: 8,
      },
      ...extra,
    ],
  };
  writeFileSync(join(storageDir, "justus.json"), JSON.stringify(v1), "utf8");
  await Promise.all([album.close(), member.close(), theirs.close()]);
  await cs.close();
  return { albumKey, memberKey, theirKey };
}

const readState = (dir: string) => JSON.parse(readFileSync(join(dir, "justus.json"), "utf8"));

describe("saved state 1 → 2", () => {
  it("moves a creator album to a new key and keeps every photo", async () => {
    const dir = makeTmpDir("justus-rotate-");
    const { albumKey, memberKey } = await seedV1(dir);
    const store = createPhotoStore(realDeps(dir));
    await store.ready();

    const state = readState(dir);
    expect(state.version).toBe(2);
    const rec = state.folders.find((f: { id: string }) => f.id === "f1");
    expect(rec.shareKey).not.toBe(albumKey);
    expect(rec.driveKey).toBe(rec.shareKey);
    expect(rec.invite.code).not.toBe("ab".repeat(32));
    expect(rec.notice).toEqual({ kind: "newKey" });
    expect(rec.retiredInvites).toBeUndefined();
    expect(rec.retiredWhy).toBeUndefined();
    expect(rec.earlier).toEqual([{ key: memberKey, name: "Nils" }]);

    const photos = await store.list();
    expect(photos.map((p) => [p.id, p.member.name]).sort()).toEqual([
      ["a1", "Me"],
      ["a2", "Me"],
      ["a3", "Me"],
      ["m1", "Nils"],
    ]);
    const { folders, activeFolderId } = await store.folders();
    expect(activeFolderId).toBe("f1");
    expect(folders.find((f) => f.id === "f1")?.notice).toEqual({ kind: "newKey" });
    expect(folders.find((f) => f.id === "f1")?.members).toBe(1);
    expect((await store.requests()).requests).toEqual([]);

    const served = JSON.stringify(store.debugState());
    expect(served).not.toContain(albumKey);
    await store.close();
  });

  it("copies bytes, metadata and thumbs, and a restart does not copy again", async () => {
    const dir = makeTmpDir("justus-rotate-");
    await seedV1(dir);
    const first = createPhotoStore(realDeps(dir));
    await first.ready();
    await first.close();
    const key = readState(dir).folders[0].shareKey;

    const cs = new Corestore(join(dir, "corestore"));
    const drive = new Hyperdrive(cs, Buffer.from(key, "hex"));
    await drive.ready();
    expect((await drive.get("/photos/a2.jpg"))?.toString()).toBe("aaa22");
    expect((await drive.get("/thumbs/a1.jpg"))?.toString()).toBe("t-aaa1");
    expect((await drive.entry("/photos/a3.jpg"))?.value.metadata).toMatchObject({ name: "a3.jpg" });
    expect(await drive.entry("/thumbs/a3.jpg")).toBeNull();
    const removed = JSON.parse((await drive.get("/removed.json"))?.toString() ?? "{}").removed;
    expect(Object.keys(removed)).toEqual([`${readState(dir).folders[0].earlier[0].key}:m2`]);
    const lengthBefore = drive.core.length;
    await drive.close();
    await cs.close();

    const second = createPhotoStore(realDeps(dir));
    await second.ready();
    await second.close();
    const after = readState(dir);
    expect(after.folders[0].shareKey).toBe(key);

    const cs2 = new Corestore(join(dir, "corestore"));
    const again = new Hyperdrive(cs2, Buffer.from(key, "hex"));
    await again.ready();
    // a restart appends only the device identity, never a second copy.
    const photos: string[] = [];
    for await (const e of again.list("/photos")) photos.push(e.key);
    expect(photos).toHaveLength(3);
    expect(again.core.length - lengthBefore).toBeLessThanOrEqual(2);
    await again.close();
    await cs2.close();
  });

  it("makes an album someone else started read-only, naming its owner", async () => {
    const dir = makeTmpDir("justus-rotate-");
    const { theirKey } = await seedV1(dir);
    const store = createPhotoStore(realDeps(dir));
    await store.ready();
    const f2 = (await store.folders()).folders.find((f) => f.id === "f2");
    expect(f2?.role).toBe("reader");
    expect(f2?.notice).toEqual({ kind: "moved", ownerName: "Greta" });
    expect(f2?.shareKey).toBe(theirKey);
    const [e] = await store.add("/nope.jpg", "x.jpg", "f2");
    expect(e?.code).toBe(PhotoError.NOT_A_MEMBER);
    await store.close();
  });

  it("leaves the record on its old key when the copy fails, then moves it next boot", async () => {
    const dir = makeTmpDir("justus-rotate-");
    const { albumKey } = await seedV1(dir);
    const deps = realDeps(dir);
    const broken = createPhotoStore(failingPut(deps, 2));
    await broken.ready();
    await broken.close();
    const mid = readState(dir);
    expect(mid.version).toBeUndefined();
    expect(mid.folders[0].shareKey).toBe(albumKey);
    expect(mid.folders[0].rotatedAt).toBeUndefined();

    const ok = createPhotoStore(realDeps(dir));
    await ok.ready();
    expect((await ok.list()).map((p) => p.id).sort((a, b) => a.localeCompare(b))).toEqual([
      "a1",
      "a2",
      "a3",
      "m1",
    ]);
    await ok.close();
    const done = readState(dir);
    expect(done.version).toBe(2);
    expect(done.folders[0].shareKey).not.toBe(albumKey);
  });

  it("refuses to open a saved state from a newer Justus and leaves the file alone", async () => {
    const dir = makeTmpDir("justus-rotate-");
    const file = join(dir, "justus.json");
    const text = JSON.stringify({ version: 3, name: "Me", folders: [], asks: [] });
    writeFileSync(file, text, "utf8");
    const store = createPhotoStore(realDeps(dir));
    await store.ready();
    const [e1] = await store.createFolder("Nope");
    expect(e1?.code).toBe(PhotoError.UPDATE_REQUIRED);
    expect(e1?.message).toBe("Update Justus to open your albums.");
    await expect(store.status()).rejects.toThrow("Update Justus to open your albums.");
    await expect(store.folders()).rejects.toThrow("Update Justus");
    await store.close();
    expect(readFileSync(file, "utf8")).toBe(text);
  });
});

describe("more rotation cases", () => {
  it("keeps the first album moved when the second fails, and moves it next boot", async () => {
    const dir = makeTmpDir("justus-rotate-");
    const { albumKey } = await seedV1(dir, { extraCreator: true });
    const deps = realDeps(dir);
    const broken = createPhotoStore(failingPut(deps, 4));
    await broken.ready();
    await broken.close();
    const mid = readState(dir);
    expect(mid.version).toBeUndefined();
    expect(mid.folders[0].shareKey).not.toBe(albumKey);
    expect(mid.folders[0].rotatedAt).toBeDefined();
    expect(mid.folders[2].rotatedAt).toBeUndefined();
    const oldSecond = mid.folders[2].shareKey;

    const ok = createPhotoStore(realDeps(dir));
    await ok.ready();
    await ok.close();
    const done = readState(dir);
    expect(done.version).toBe(2);
    expect(done.folders[0].shareKey).toBe(mid.folders[0].shareKey);
    expect(done.folders[2].shareKey).not.toBe(oldSecond);
  });

  it("moves an album that is the device identity drive and keeps its photos", async () => {
    const dir = makeTmpDir("justus-rotate-");
    const cs = new Corestore(join(dir, "corestore"));
    const own = new Hyperdrive(cs);
    await own.ready();
    const key = own.key.toString("hex");
    await own.put("/folder.json", bytes(JSON.stringify({ version: 1, name: "Old" })));
    await putPhoto(own, "l1", "ll1", true);
    await putPhoto(own, "l2", "ll22", false);
    await own.close();
    await cs.close();
    writeFileSync(
      join(dir, "justus.json"),
      JSON.stringify({
        name: "Me",
        activeFolderId: "f1",
        asks: [],
        folders: [
          { id: "f1", name: "Old", role: "creator", shareKey: key, driveKey: key, createdAt: 1 },
        ],
      }),
      "utf8",
    );
    const store = createPhotoStore(realDeps(dir));
    await store.ready();
    expect((await store.list()).map((p) => p.id).sort((a, b) => a.localeCompare(b))).toEqual([
      "l1",
      "l2",
    ]);
    await store.close();
    const state = readState(dir);
    expect(state.version).toBe(2);
    expect(state.folders[0].shareKey).not.toBe(key);
  });
});

describe("copyAlbumEntries", () => {
  async function pair() {
    const dir = makeTmpDir("justus-rotate-");
    const store = createHyperDriveStore(dir);
    const from = await store.openOwn("a");
    const to = await store.openOwn("b");
    return { from, to, close: () => store.close() };
  }
  const withHash = (name: string, sha256: string) => ({ ...meta(name), sha256 });

  it("rejects a copy of the same size whose sha256 differs", async () => {
    const { from, to, close } = await pair();
    await from.put("/photos/p1.jpg", bytes("one"), { metadata: withHash("p1.jpg", "aa") });
    await to.put("/photos/p1.jpg", bytes("two"), { metadata: withHash("p1.jpg", "bb") });
    await expect(copyAlbumEntries(from, to)).rejects.toThrow(/copy incomplete 1 of 1/);
    await close();
  });

  it("accepts a matching sha256 and does not rewrite a copy that already matches", async () => {
    const { from, to, close } = await pair();
    await from.put("/photos/p1.jpg", bytes("one"), { metadata: withHash("p1.jpg", "aa") });
    await to.put("/photos/p1.jpg", bytes("one"), { metadata: withHash("p1.jpg", "aa") });
    const length = to.stats().length;
    await expect(copyAlbumEntries(from, to)).resolves.toEqual({ photos: 1, thumbs: 0 });
    expect(to.stats().length).toBe(length);
    await close();
  });

  it("reports a copy that is not complete", async () => {
    const { from, to, close } = await pair();
    await putPhoto(from, "p1", "one", true);
    await putPhoto(from, "p2", "two", false);
    to.put = async () => undefined;
    await expect(copyAlbumEntries(from, to)).rejects.toThrow(/copy incomplete 2 of 2/);
    await close();
  });
});
