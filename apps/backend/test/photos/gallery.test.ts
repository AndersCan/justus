import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Drive } from "../../src/ports/drive-store.ts";
import {
  addFakeNode,
  createFakeDriveStore,
  createFakeHub,
  setFakeNodeConnected,
  type FakeWorldOptions,
} from "../fakes/fake-world.ts";
import { addPhoto, galleryDrives, listGallery } from "../../src/photos/gallery.ts";

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

function nextChange(drive: Drive, ms = 1000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`no change event from drive ${drive.key.slice(0, 8)} within ${ms} ms`));
    }, ms);
    const unsubscribe = drive.onChange(() => {
      clearTimeout(timer);
      unsubscribe();
      resolve();
    });
  });
}

function newPhoto(id: string) {
  return {
    id,
    ext: ".jpg",
    bytes: Buffer.from(`bytes-${id}`),
    name: `${id}.jpg`,
    mime: "image/jpeg",
    sha256: "a".repeat(64),
  };
}

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
    const { photos } = await listGallery(sources, {
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
    const { photos } = await listGallery(sources, {
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
    const { photos } = await listGallery(sources, {
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
    ).toEqual({ photos: [], removed: {}, complete: true });
  });

  it("is complete when the removed list is missing, and returns its tombstones", async () => {
    const [a, b] = devices(2);
    const da = await a.drives.openOwn("a");
    const db = await b.drives.openOwn("b");
    await photoAt(db, { id: "gone", addedAt: 2000 });
    const tombstone = { memberKey: db.key, removedAt: 5 };
    const read = () =>
      listGallery(
        [da, db].map((drive) => ({ key: drive.key, drive })),
        {
          removedFrom: da,
          memberName: () => "X",
          log: a.log,
        },
      );
    const before = await read();
    await da.put("/removed.json", json({ version: 1, removed: { [`${db.key}:gone`]: tombstone } }));
    const after = await read();
    expect({
      before: [before.complete, before.removed],
      after: [after.complete, after.removed],
    }).toEqual({
      before: [true, {}],
      after: [true, { [`${db.key}:gone`]: tombstone }],
    });
  });

  it("is incomplete when a drive scan fails", async () => {
    let bad = "";
    const [a, b] = devices(2, { unreachable: (k) => k === bad });
    const da = await a.drives.openOwn("a");
    const db = await b.drives.openOwn("b");
    bad = db.key;
    const { complete } = await listGallery(
      [da, db].map((drive) => ({ key: drive.key, drive })),
      {
        removedFrom: da,
        memberName: () => "X",
        log: a.log,
      },
    );
    expect(complete).toBe(false);
  });

  it("is incomplete when the removed list cannot be read, and logs drive.read", async () => {
    const [a] = devices(1);
    const da = await a.drives.openOwn("a");
    const broken = Object.create(da) as typeof da;
    broken.readSmall = async () => {
      throw new Error("boom");
    };
    const { complete } = await listGallery([{ key: da.key, drive: da }], {
      removedFrom: broken,
      memberName: () => "X",
      log: a.log,
    });
    expect({ complete, events: a.events.map((e) => e.fields?.where) }).toEqual({
      complete: false,
      events: ["drive.read"],
    });
  });
});

describe("addPhoto", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_700_000_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes the photo with its metadata and gives the entry the gallery will show", async () => {
    const [ann] = devices(1);
    const drive = await ann.drives.openOwn("folder/a");
    const [writeErr, added] = await addPhoto(drive, newPhoto("p1"));
    const { photos: listed } = await listGallery([{ key: drive.key, drive }], {
      removedFrom: drive,
      memberName: () => "Ann",
      log: ann.log,
    });
    expect({ writeErr, listed, bytes: await drive.readBytes("/photos/p1.jpg") }).toEqual({
      writeErr: null,
      listed: [{ ...added, memberName: "Ann" }],
      bytes: new Uint8Array(Buffer.from("bytes-p1")),
    });
  });

  it("writes the thumbnail before the photo", async () => {
    const [ann] = devices(1);
    const drive = await ann.drives.openOwn("folder/a");
    const paths: string[] = [];
    const spy: Drive = {
      ...drive,
      put: async (path, bytes, opts) => {
        paths.push(path);
        return drive.put(path, bytes, opts);
      },
    };
    const [, added] = await addPhoto(spy, { ...newPhoto("p1"), thumb: Buffer.from("t") });
    expect({ paths, hasThumb: added?.hasThumb }).toEqual({
      paths: ["/thumbs/p1.jpg", "/photos/p1.jpg"],
      hasThumb: true,
    });
  });

  it("gives write-failed on a drive this device cannot write", async () => {
    const [admin, member] = devices(2);
    const folder = await admin.drives.openOwn("folder/a");
    const [openErr, copy] = await member.drives.open(folder.key, { timeoutMs: 50 });
    expect(openErr).toBeNull();
    expect(await addPhoto(copy!, newPhoto("p1"))).toEqual([
      { kind: "write-failed", message: "Drive is not writable" },
      null,
    ]);
  });

  it("a photo the Admin adds shows in a member's gallery once the member's copy reports a change", async () => {
    const [admin, member] = devices(2);
    const folder = await admin.drives.openOwn("folder/a");
    const selfDrive = await member.drives.openOwn(`member/${folder.key}`);
    const [, memberCopy] = await member.drives.open(folder.key, { timeoutMs: 50 });
    const changed = nextChange(memberCopy!);
    const [, added] = await addPhoto(folder, newPhoto("p1"));
    await changed;
    const { photos: gallery } = await listGallery(
      galleryDrives({
        role: "member",
        folderDrive: memberCopy!,
        selfDrive,
        memberDrives: new Map(),
      }),
      { removedFrom: memberCopy!, memberName: () => "Admin", log: member.log },
    );
    expect(gallery).toEqual([{ ...added, memberName: "Admin" }]);
  });

  it("a photo a member adds shows in the Admin's gallery", async () => {
    const [admin, member] = devices(2);
    const folder = await admin.drives.openOwn("folder/a");
    const selfDrive = await member.drives.openOwn(`member/${folder.key}`);
    const [, memberCopy] = await admin.drives.open(selfDrive.key, { timeoutMs: 50 });
    const changed = nextChange(memberCopy!);
    const [, added] = await addPhoto(selfDrive, newPhoto("p2"));
    await changed;
    const { photos: gallery } = await listGallery(
      galleryDrives({
        role: "creator",
        folderDrive: folder,
        selfDrive: folder,
        memberDrives: new Map([[selfDrive.key, memberCopy!]]),
      }),
      { removedFrom: folder, memberName: () => "Bo", log: admin.log },
    );
    expect(gallery).toEqual([{ ...added, memberName: "Bo" }]);
  });

  it("a member who was offline sees the photo once it reconnects", async () => {
    const [admin, member] = devices(2);
    const folder = await admin.drives.openOwn("folder/a");
    const selfDrive = await member.drives.openOwn(`member/${folder.key}`);
    const [, memberCopy] = await member.drives.open(folder.key, { timeoutMs: 50 });
    setFakeNodeConnected({ hub: member.hub, node: member.node, connected: false });
    const [, added] = await addPhoto(folder, newPhoto("p1"));
    const read = () =>
      listGallery(
        galleryDrives({
          role: "member",
          folderDrive: memberCopy!,
          selfDrive,
          memberDrives: new Map(),
        }),
        { removedFrom: memberCopy!, memberName: () => "Admin", log: member.log },
      );
    const before = await read();
    const changed = nextChange(memberCopy!);
    setFakeNodeConnected({ hub: member.hub, node: member.node, connected: true });
    await changed;
    expect({ before: before.photos, after: (await read()).photos }).toEqual({
      before: [],
      after: [{ ...added, memberName: "Admin" }],
    });
  });
});
