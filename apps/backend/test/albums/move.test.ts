import { describe, expect, it } from "vite-plus/test";
import type { Drive, DriveStore } from "../../src/ports/drive-store.ts";
import {
  addFakeNode,
  createFakeDriveStore,
  createFakeHub,
  setFakeNodeConnected,
} from "../fakes/fake-world.ts";
import { moveAlbum } from "../../src/albums/move.ts";
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

  it("a failed put returns an error and leaves the old drive unchanged", async () => {
    const drives = phone();
    const old = await oldAlbum(drives);
    const before = JSON.stringify(await listAll(old));
    const failing: DriveStore = {
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
    };
    const [err, moved] = await run(failing, old);
    expect(err, "move: error").toMatchObject({ message: "disk full" });
    expect(moved).toBeNull();
    expect(JSON.stringify(await listAll(old)), "move: old drive untouched").toBe(before);
  });
});

async function listAll(drive: Drive) {
  const out: string[] = [];
  for await (const e of drive.list("/")) out.push(`${e.path}:${e.size}`);
  return out;
}
