import { describe, expect, it } from "vite-plus/test";
import type { Drive } from "../../src/ports/drive-store.ts";
import {
  addFakeNode,
  createFakeDriveStore,
  createFakeHub,
  setFakeNodeConnected,
  type FakeWorldOptions,
} from "../fakes/fake-world.ts";
import { galleryDrives, listGallery } from "../../src/photos/gallery.ts";

type LogEntry = { event: string; fields?: Record<string, unknown> };

function devices(n: number, options?: FakeWorldOptions) {
  const hub = createFakeHub(options);
  return Array.from({ length: n }, () => {
    const node = addFakeNode(hub);
    setFakeNodeConnected({ hub, node, connected: true });
    const events: LogEntry[] = [];
    return {
      hub,
      node,
      drives: createFakeDriveStore({ hub, node }),
      events,
      log: (event: string, fields?: Record<string, unknown>) => events.push({ event, fields }),
    };
  });
}

async function photoAt(drive: Drive, photo: { id: string; addedAt: number; name?: string }) {
  const { id, addedAt, name = `${id}.jpg` } = photo;
  await drive.put(`/photos/${id}.jpg`, Buffer.from(id), {
    metadata: { addedAt, name, mime: "image/jpeg" },
  });
}

const json = (value: unknown) => Buffer.from(JSON.stringify(value));
const noName = () => undefined;

describe("galleryDrives", () => {
  it("lists the Admin's drive first, then this device's, then the other members'", async () => {
    const [admin, me, other] = devices(3);
    const folderDrive = await admin.drives.openOwn("folder");
    const selfDrive = await me.drives.openOwn("self");
    const otherDrive = await other.drives.openOwn("other");
    const memberDrives = new Map([[otherDrive.key, otherDrive]]);
    expect(galleryDrives({ role: "member", folderDrive, selfDrive, memberDrives })).toEqual([
      { key: folderDrive.key, drive: folderDrive },
      { key: selfDrive.key, drive: selfDrive },
      { key: otherDrive.key, drive: otherDrive },
    ]);
  });

  it("gives the Admin its own drive and the members' drives, each listed once", async () => {
    const [admin, m1, m2] = devices(3);
    const folderDrive = await admin.drives.openOwn("folder");
    const d1 = await m1.drives.openOwn("a");
    const d2 = await m2.drives.openOwn("b");
    const memberDrives = new Map([
      [d1.key, d1],
      [folderDrive.key, folderDrive],
      [d2.key, d2],
    ]);
    expect(
      galleryDrives({ role: "creator", folderDrive, selfDrive: folderDrive, memberDrives }),
    ).toEqual([
      { key: folderDrive.key, drive: folderDrive },
      { key: d1.key, drive: d1 },
      { key: d2.key, drive: d2 },
    ]);
  });

  it("gives a reader the Admin's drive and the members' drives, not its own", async () => {
    const [admin, reader, m1] = devices(3);
    const folderDrive = await admin.drives.openOwn("folder");
    const selfDrive = await reader.drives.openOwn("self");
    const d1 = await m1.drives.openOwn("a");
    expect(
      galleryDrives({
        role: "reader",
        folderDrive,
        selfDrive,
        memberDrives: new Map([[d1.key, d1]]),
      }),
    ).toEqual([
      { key: folderDrive.key, drive: folderDrive },
      { key: d1.key, drive: d1 },
    ]);
  });
});

describe("listGallery", () => {
  it("shows every drive's photos newest first with the member names", async () => {
    const [a, b, c] = devices(3);
    const da = await a.drives.openOwn("a");
    const db = await b.drives.openOwn("b");
    const dc = await c.drives.openOwn("c");
    await photoAt(da, { id: "p1", addedAt: 1000 });
    await photoAt(db, { id: "p2", addedAt: 3000 });
    await photoAt(dc, { id: "p3", addedAt: 2000 });
    await db.put("/device.json", json({ name: "Bo" }));
    const sources = [da, db, dc].map((drive) => ({ key: drive.key, drive }));
    const photos = await listGallery(sources, {
      removedFrom: da,
      memberName: (k) => (k === da.key ? "Ann" : undefined),
      log: a.log,
    });
    expect(photos.map((p) => [p.id, p.memberName])).toEqual([
      ["p2", "Bo"],
      ["p3", "Unknown device"],
      ["p1", "Ann"],
    ]);
  });

  it("hides a photo the album's removed record lists", async () => {
    const [a, b] = devices(2);
    const da = await a.drives.openOwn("a");
    const db = await b.drives.openOwn("b");
    await photoAt(da, { id: "keep", addedAt: 1000 });
    await photoAt(db, { id: "gone", addedAt: 2000 });
    await da.put(
      "/removed.json",
      json({ version: 1, removed: { [`${db.key}:gone`]: { memberKey: db.key, removedAt: 5 } } }),
    );
    const sources = [da, db].map((drive) => ({ key: drive.key, drive }));
    const photos = await listGallery(sources, {
      removedFrom: da,
      memberName: () => "X",
      log: a.log,
    });
    expect(photos.map((p) => p.id)).toEqual(["keep"]);
  });

  it("skips a drive it cannot list and logs drive.scan", async () => {
    let bad = "";
    const [a, b] = devices(2, { unreachable: (k) => k === bad });
    const da = await a.drives.openOwn("a");
    const db = await b.drives.openOwn("b");
    bad = db.key;
    await photoAt(da, { id: "p1", addedAt: 1000 });
    await photoAt(db, { id: "p2", addedAt: 2000 });
    const sources = [da, db].map((drive) => ({ key: drive.key, drive }));
    const photos = await listGallery(sources, {
      removedFrom: da,
      memberName: () => "X",
      log: a.log,
    });
    expect({ ids: photos.map((p) => p.id), events: a.events }).toEqual({
      ids: ["p1"],
      events: [
        {
          event: "error",
          fields: { where: "drive.scan", drive: db.key.slice(0, 8), err: "fake drive unreachable" },
        },
      ],
    });
  });

  it("of an empty album is empty", async () => {
    const [a] = devices(1);
    const da = await a.drives.openOwn("a");
    expect(
      await listGallery([{ key: da.key, drive: da }], {
        removedFrom: da,
        memberName: noName,
        log: a.log,
      }),
    ).toEqual([]);
  });
});
