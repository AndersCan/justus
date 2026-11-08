import { describe, expect, it } from "vite-plus/test";
import type { Drive, DriveStore } from "../../src/ports/drive-store.ts";
import {
  addFakeNode,
  createFakeDriveStore,
  createFakeHub,
  setFakeNodeConnected,
} from "../fakes/fake-world.ts";
import { MAX_EARLIER, copyOwnEntries, countShownPhotos, moveAlbum } from "../../src/albums/move.ts";
import { ensureHoldingMarker, markHeld } from "../../src/photos/holders.ts";
import { parseEarlier } from "../../src/membership/records.ts";

const M = "b".repeat(64);
const N = "c".repeat(64);
const V = "d".repeat(64);
const GONE = "e".repeat(64);
const device = Buffer.from(JSON.stringify({ name: "Anna" }));
const json = (value: unknown) => Buffer.from(JSON.stringify(value));

function phone() {
  const hub = createFakeHub();
  const node = addFakeNode(hub);
  setFakeNodeConnected({ hub, node, connected: true });
  return createFakeDriveStore({ hub, node });
}

async function oldAlbum(drives: DriveStore) {
  const drive = await drives.openOwn("folder/f1");
  await drive.put("/photos/a.jpg", Buffer.from("photo-a"));
  await drive.put("/thumbs/a.jpg", Buffer.from("thumb-a"));
  await drive.put("/folder.json", json({ version: 1, name: "Trip" }));
  await drive.put(
    "/removed.json",
    json({
      version: 1,
      removed: {
        [`${M}:1`]: { memberKey: M, removedAt: 1 },
        [`${GONE}:1`]: { memberKey: GONE, removedAt: 2 },
      },
    }),
  );
  return drive;
}

const remaining = {
  members: { [M]: { key: M, name: "Ben", addedAt: 1 }, [N]: { key: N, name: "Cy", addedAt: 2 } },
  viewers: { [V]: { key: V, name: "Vi", addedAt: 3, keptVersion: 7 } },
};

const run = (drives: DriveStore, old: Drive, over: Record<string, unknown> = {}) =>
  moveAlbum(
    { drives, log: () => {} },
    {
      record: { id: "f1", name: "Trip" },
      oldDrive: old,
      remaining,
      removedKey: GONE,
      device: async () => device,
      inviteCode: "code-2",
      ...over,
    },
  );

const read = async (drive: Drive, path: string) =>
  JSON.parse((await drive.readSmall(path, 1e6)) ?? "null");

describe("moveAlbum", () => {
  it("carries the Admin's record of held photos to the new drive", async () => {
    const drives = phone();
    const old = await oldAlbum(drives);
    await ensureHoldingMarker(old);
    await markHeld(old, "p1");
    const [err, moved] = await run(drives, old);
    expect(err, "move: succeeds").toBeNull();
    const target = await drives.openOwn("folder/f1/m1");
    expect(target.key).toBe(moved!.shareKey);
    expect(await target.readSmall("/holding.json", 1e6), "move: marker").toBe('{"version":1}');
    const ids: string[] = [];
    for await (const e of target.list("/held")) ids.push(e.path);
    expect(ids, "move: held entry").toEqual(["/held/p1"]);
  });

  it("copies the Admin's photos and writes the six files on a new drive", async () => {
    const drives = phone();
    const old = await oldAlbum(drives);
    const [err, moved] = await run(drives, old);
    expect(err, "move: succeeds").toBeNull();
    expect(moved!.shareKey, "move: new key").not.toBe(old.key);
    expect(moved).toMatchObject({
      driveKey: moved!.shareKey,
      invite: { code: "code-2" },
      moves: 1,
    });
    const target = await drives.openOwn("folder/f1/m1");
    expect(target.key, "move: lands on folder/<id>/m<n>").toBe(moved!.shareKey);
    expect(
      Buffer.from((await target.readBytes("/photos/a.jpg")) ?? []).toString(),
      "move: photo",
    ).toBe("photo-a");
    expect(
      Buffer.from((await target.readBytes("/thumbs/a.jpg")) ?? []).toString(),
      "move: thumb",
    ).toBe("thumb-a");
    expect(await target.readSmall("/device.json", 1e6), "move: device").toBe(device.toString());
    expect(await read(target, "/folder.json"), "move: name").toEqual({ version: 1, name: "Trip" });
    expect(await read(target, "/viewers.json"), "move: no Viewers").toEqual({
      version: 1,
      viewers: {},
    });
    expect(await read(target, "/members.json"), "move: empty registry").toEqual({
      version: 1,
      members: {},
    });
    expect(
      Object.keys((await read(target, "/removed.json")).removed),
      "move: tombstones of remaining only",
    ).toEqual([`${M}:1`]);
    expect(
      parseEarlier((await target.readSmall("/earlier.json", 1e6)) ?? null),
      "move: earlier",
    ).toEqual(moved!.earlier);
  });

  it("lists remaining people's drives, keeps keptVersion, and never the removed one", async () => {
    const drives = phone();
    const old = await oldAlbum(drives);
    const [, moved] = await run(drives, old, {
      record: {
        id: "f1",
        name: "Trip",
        earlier: [
          { key: GONE, name: "Ben" },
          { key: "f".repeat(64), name: "Old" },
        ],
      },
    });
    expect(moved!.earlier, "move: earlier list").toEqual([
      { key: "f".repeat(64), name: "Old" },
      { key: M, name: "Ben" },
      { key: N, name: "Cy" },
      { key: V, name: "Vi", keptVersion: 7 },
    ]);
  });

  it("a second move uses the next namespace", async () => {
    const drives = phone();
    const old = await oldAlbum(drives);
    const [err, moved] = await run(drives, old, { record: { id: "f1", name: "Trip", moves: 1 } });
    expect(err).toBeNull();
    expect(moved!.moves).toBe(2);
    expect((await drives.openOwn("folder/f1/m2")).key).toBe(moved!.shareKey);
  });

  it("never lists the old drive or the new drive as a source", async () => {
    const drives = phone();
    const old = await oldAlbum(drives);
    const target = await drives.openOwn("folder/f1/m1");
    const [, moved] = await run(drives, old, {
      record: { id: "f1", name: "Trip", earlier: [{ key: old.key, name: "Self" }] },
      remaining: {
        members: { ...remaining.members, [target.key]: { key: target.key, name: "T", addedAt: 4 } },
        viewers: remaining.viewers,
      },
    });
    const keys = moved!.earlier.map((e: { key: string }) => e.key);
    expect(keys, "move: old drive not a source").not.toContain(old.key);
    expect(keys, "move: new drive not a source").not.toContain(target.key);
    expect(keys, "move: others stay").toEqual([M, N, V]);
  });

  it("a Viewer without keptVersion is not a source", async () => {
    const drives = phone();
    const old = await oldAlbum(drives);
    const [, moved] = await run(drives, old, {
      remaining: { members: {}, viewers: { [V]: { key: V, name: "Vi", addedAt: 3 } } },
    });
    expect(moved!.earlier).toEqual([]);
  });

  it("caps the earlier list, keeping the earliest sources first", async () => {
    const drives = phone();
    const old = await oldAlbum(drives);
    const keyOf = (i: number) => (i + 1).toString(16).padStart(64, "0");
    const earlier = Array.from({ length: MAX_EARLIER }, (_, i) => ({ key: keyOf(i), name: "n" }));
    const [, moved] = await run(drives, old, { record: { id: "f1", name: "Trip", earlier } });
    expect(moved!.earlier.map((e: { key: string }) => e.key)).toEqual(earlier.map((e) => e.key));
    const target = await drives.openOwn("folder/f1/m1");
    expect(
      parseEarlier((await target.readSmall("/earlier.json", 1e6)) ?? null),
      "move: file capped too",
    ).toHaveLength(MAX_EARLIER);
  });

  it("releases the new drive on success and on failure", async () => {
    for (const fail of [false, true]) {
      const drives = phone();
      const old = await oldAlbum(drives);
      const released: string[] = [];
      const base = fail ? failingPut(drives) : drives;
      const spy: DriveStore = {
        ...base,
        openOwn: (ns) => base.openOwn(ns),
        release: async (d) => {
          released.push(d.key);
          return drives.release(d);
        },
      };
      const [err] = await run(spy, old);
      expect(err === null, `move: fail=${fail}`).toBe(!fail);
      const target = await drives.openOwn("folder/f1/m1");
      expect(released, `release: fail=${fail}`).toEqual([target.key]);
    }
  });

  it("a retry after a partial failure lands on the same namespace", async () => {
    const drives = phone();
    const old = await oldAlbum(drives);
    const [err1] = await run(failingPut(drives), old);
    expect(err1).not.toBeNull();
    const [err2, moved] = await run(drives, old);
    expect(err2).toBeNull();
    expect(moved!.moves).toBe(1);
    const target = await drives.openOwn("folder/f1/m1");
    expect(parseEarlier((await target.readSmall("/earlier.json", 1e6)) ?? null)).toHaveLength(3);
  });

  it("a failed put returns an error and leaves the old drive unchanged", async () => {
    const drives = phone();
    const old = await oldAlbum(drives);
    const before = JSON.stringify(await listAll(old));
    const [err, moved] = await run(failingPut(drives), old);
    expect(err, "move: error").toMatchObject({ message: "disk full" });
    expect(moved).toBeNull();
    expect(JSON.stringify(await listAll(old)), "move: old drive untouched").toBe(before);
  });
});

const failingPut = (drives: DriveStore): DriveStore => ({
  ...drives,
  openOwn: async (ns) => {
    const d = await drives.openOwn(ns);
    return new Proxy(d, {
      get: (t, p) =>
        p === "put"
          ? async (path: string, ...rest: unknown[]) => {
              if (path === "/earlier.json") throw new Error("disk full");
              return (t.put as (...a: unknown[]) => Promise<void>)(path, ...rest);
            }
          : (t as never)[p],
    });
  },
});

async function listAll(drive: Drive) {
  const out: string[] = [];
  for await (const e of drive.list("/")) out.push(`${e.path}:${e.size}`);
  return out;
}

describe("copyOwnEntries and countShownPhotos", () => {
  async function twoDrives() {
    const drives = phone();
    const from = await drives.openOwn("old");
    const to = await drives.openOwn("new");
    for (const id of ["p1", "p2", "p3"]) {
      await from.put(`/photos/${id}.jpg`, Buffer.from(`photo-${id}`));
      await from.put(`/thumbs/${id}.jpg`, Buffer.from(`thumb-${id}`));
    }
    return { from, to };
  }

  it("copies photos and thumbnails except the removed ones", async () => {
    const { from, to } = await twoDrives();
    expect(await copyOwnEntries(from, to, new Set(["p2"]))).toBe(2);
    const paths = (await listAll(to))
      .map((e) => e.split(":")[0]!)
      .sort((a, b) => a.localeCompare(b));
    expect(paths).toEqual(["/photos/p1.jpg", "/photos/p3.jpg", "/thumbs/p1.jpg", "/thumbs/p3.jpg"]);
  });

  it("is repeatable: a second run copies nothing", async () => {
    const { from, to } = await twoDrives();
    await copyOwnEntries(from, to, new Set());
    expect(await copyOwnEntries(from, to, new Set())).toBe(0);
  });

  it("keeps each copied photo's metadata", async () => {
    const drives = phone();
    const from = await drives.openOwn("old");
    const to = await drives.openOwn("new");
    await from.put("/photos/p1.jpg", Buffer.from("photo-p1"), { metadata: { takenAt: 42 } });
    await copyOwnEntries(from, to, new Set());
    const metadata: unknown[] = [];
    for await (const e of to.list("/photos")) metadata.push(e.metadata);
    expect(metadata).toEqual([{ takenAt: 42 }]);
  });

  it("counts the photos not removed", async () => {
    const { from } = await twoDrives();
    expect(await countShownPhotos(from, new Set())).toBe(3);
    expect(await countShownPhotos(from, new Set(["p1", "p3"]))).toBe(1);
  });
});
