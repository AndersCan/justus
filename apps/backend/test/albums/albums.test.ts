import { describe, expect, it } from "vite-plus/test";
import type { Drive, DriveStore } from "../../src/ports/drive-store.ts";
import {
  addFakeNode,
  createFakeDriveStore,
  createFakeHub,
  setFakeNodeConnected,
} from "../fakes/fake-world.ts";
import {
  albumNameUpdate,
  albumSummary,
  createAlbumDrive,
  removeAlbumMember,
  rotateAlbum,
  type AlbumSummarySource,
} from "../../src/albums/albums.ts";
import { isEnrolled, parseRegistry } from "../../src/membership/records.ts";

type LogEntry = { event: string; fields?: Record<string, unknown> };

function devices(n: number) {
  const hub = createFakeHub();
  return Array.from({ length: n }, () => {
    const node = addFakeNode(hub);
    setFakeNodeConnected({ hub, node, connected: true });
    const events: LogEntry[] = [];
    return {
      drives: createFakeDriveStore({ hub, node }),
      events,
      log: (event: string, fields?: Record<string, unknown>) => events.push({ event, fields }),
    };
  });
}

const json = (value: unknown) => Buffer.from(JSON.stringify(value));

async function until(check: () => Promise<boolean>, options: { ms?: number; what: string }) {
  const { ms = 1000, what } = options;
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`${what} within ${ms} ms`);
}

async function created(
  drives: DriveStore,
  id: string,
  name: string,
  device = json({ name: "Maya" }),
) {
  const [err, drive] = await createAlbumDrive(drives, { id, name, device });
  if (err) throw new Error(err.message);
  return drive;
}

const readerSource = (
  overrides: Partial<AlbumSummarySource["record"]> = {},
): AlbumSummarySource => ({
  record: {
    id: "f1",
    name: "Trip",
    role: "reader",
    shareKey: "share",
    createdAt: 5,
    ...overrides,
  },
  selfDrive: { key: "self" },
  memberDrives: new Map(),
});

describe("create", () => {
  it("a new album gets a drive of its own that names it to whoever opens it", async () => {
    const [admin, friend] = devices(2);
    const device = json({ name: "Maya" });
    const drive = await created(admin.drives, "f1", "Trip", device);
    const other = await created(admin.drives, "f2", "Other");
    const identity = await admin.drives.openOwn();
    expect(drive.key, "Trip: create: not the identity drive").not.toBe(identity.key);
    expect(drive.key, "Trip: create: differs from a second album").not.toBe(other.key);

    const [err, remote] = await friend.drives.open(drive.key, { timeoutMs: 500 });
    expect(err, "Trip: create: friend opens it").toBeNull();
    expect(await remote!.readSmall("/folder.json", 1e6), "Trip: create: names the album").toBe(
      '{"version":1,"name":"Trip"}',
    );
    expect(await remote!.readSmall("/device.json", 1e6), "Trip: create: names the device").toBe(
      device.toString(),
    );
  });

  it("a failed write is a value, not a throw", async () => {
    const [admin] = devices(1);
    const failing: DriveStore = {
      ...admin.drives,
      openOwn: async (ns) => {
        const drive = await admin.drives.openOwn(ns);
        return {
          ...drive,
          put: async () => {
            throw new Error("disk full");
          },
        } as Drive;
      },
    };
    const result = await createAlbumDrive(failing, { id: "f1", name: "Trip", device: json({}) });
    expect(result, "Trip: create: failure is returned").toEqual([
      { kind: "write-failed", message: "disk full" },
      null,
    ]);
  });
});

describe("name", () => {
  it("a joined album takes the name its Admin gives it", async () => {
    const [admin, friend, other] = devices(3);
    const drive = await created(admin.drives, "f1", "Trip");
    const [, remote] = await friend.drives.open(drive.key, { timeoutMs: 500 });
    expect(
      await albumNameUpdate(remote!, { role: "reader", current: "Joined folder", log: friend.log }),
      "Trip: name: reader takes the Admin's name",
    ).toBe("Trip");
    expect(
      await albumNameUpdate(remote!, { role: "reader", current: "Trip", log: other.log }),
      "Trip: name: unchanged name gives nothing",
    ).toBeUndefined();
  });

  it("an Admin's own album never takes a name from a drive", async () => {
    const [admin] = devices(1);
    const drive = await created(admin.drives, "f1", "Trip");
    const broken = {
      ...drive,
      readSmall: async () => {
        throw new Error("must not read");
      },
    } as Drive;
    expect(
      await albumNameUpdate(broken, { role: "creator", current: "Old", log: admin.log }),
      "Trip: name: Admin keeps its own name",
    ).toBeUndefined();
    expect(admin.events, "Trip: name: nothing was read").toEqual([]);
  });

  it("a missing or broken /folder.json keeps the name shown", async () => {
    const [admin, friend] = devices(2);
    const empty = await admin.drives.openOwn("empty");
    const update = (drive: Drive) =>
      albumNameUpdate(drive, { role: "reader", current: "Joined folder", log: friend.log });
    expect(await update(empty), "Trip: name: missing file").toBeUndefined();
    await empty.put("/folder.json", Buffer.from("not json"));
    expect(await update(empty), "Trip: name: malformed file").toBeUndefined();

    const throwing = {
      ...empty,
      readSmall: async () => {
        throw new Error("io");
      },
    } as Drive;
    expect(await update(throwing), "Trip: name: unreadable file").toBeUndefined();
    expect(friend.events, "Trip: name: read error is logged").toEqual([
      {
        event: "error",
        fields: {
          where: "drive.read",
          drive: empty.key.slice(0, 8),
          path: "/folder.json",
          err: "io",
        },
      },
    ]);
  });
});

describe("list", () => {
  it("an Admin's album counts the Admin and its live members, not the old ones", () => {
    const source: AlbumSummarySource = {
      ...readerSource({
        role: "creator",
        earlier: [{ key: "old", name: "x" }],
        notice: undefined,
      }),
      memberDrives: new Map([
        ["a", 1],
        ["b", 1],
        ["old", 1],
      ]),
    };
    const summary = albumSummary(
      { ...source, record: { ...source.record, invite: { code: "c" } } },
      { ownIdentity: "me" },
    );
    expect(summary.members, "Trip: list: an Admin counts itself").toBe(3);
    expect(summary.driveKey, "Trip: list: Admin shows its drive").toBe("self");
    expect(summary.invite?.owner, "Trip: list: owner defaults to this identity").toBe("me");
    expect("notice" in summary, "Trip: list: no notice key").toBe(false);
    const owned = albumSummary(
      { ...source, record: { ...source.record, invite: { code: "c", owner: "them" } } },
      { ownIdentity: "me" },
    );
    expect(owned.invite?.owner, "Trip: list: a given owner is kept").toBe("them");
  });

  it("a reader shows no drive of its own unless it asked to write", () => {
    const members = new Map([["a", 1]]);
    const plain = albumSummary({ ...readerSource(), memberDrives: members }, { ownIdentity: "me" });
    expect(plain.driveKey, "Trip: list: reader has no drive").toBe("");
    expect(plain.members, "Trip: list: reader counts visible writers").toBe(1);
    const pending = albumSummary(readerSource({ pending: true }), { ownIdentity: "me" });
    expect(pending.driveKey, "Trip: list: pending reader shows its drive").toBe("self");
    expect(pending.pending, "Trip: list: pending flag").toBe(true);
    const moved = albumSummary(readerSource({ notice: { kind: "moved", ownerName: "Maya" } }), {
      ownIdentity: "me",
    });
    expect(moved.notice, "Trip: list: notice kept").toEqual({ kind: "moved", ownerName: "Maya" });
  });
});

describe("remove", () => {
  async function albumWithMembers(admin: ReturnType<typeof devices>[number], keys: string[]) {
    const drive = await created(admin.drives, "f1", "Trip");
    const members = Object.fromEntries(keys.map((k) => [k, { key: k, name: k, addedAt: 1 }]));
    await drive.put("/members.json", json({ version: 1, members }));
    return drive;
  }
  const M = "m".repeat(64);
  const N = "n".repeat(64);

  it("a removed member drops out of the album on every device", async () => {
    const [admin, friend] = devices(2);
    const drive = await albumWithMembers(admin, [M, N]);
    const [, remote] = await friend.drives.open(drive.key, { timeoutMs: 500 });
    const [err, registry] = await removeAlbumMember(drive, { memberKey: M, log: admin.log });
    expect(err, "Trip: remove: succeeds").toBeNull();
    expect(Object.keys(registry!.members), "Trip: remove: only N is left").toEqual([N]);
    await until(
      async () =>
        !isEnrolled(parseRegistry((await remote!.readSmall("/members.json", 1e6)) ?? null), M),
      { what: "friend sees M removed" },
    );
    const seen = parseRegistry((await remote!.readSmall("/members.json", 1e6)) ?? null);
    expect(isEnrolled(seen, N), "Trip: remove: N stays enrolled").toBe(true);
  });

  it("removing someone who is not a member writes nothing", async () => {
    const [admin] = devices(1);
    const drive = await albumWithMembers(admin, [N]);
    const before = drive.stats().length;
    const result = await removeAlbumMember(drive, { memberKey: M, log: admin.log });
    expect(result[0]?.kind, "Trip: remove: not a member").toBe("no-such-member");
    expect(drive.stats().length, "Trip: remove: nothing written").toBe(before);
  });

  it("only the Admin's device can remove a member", async () => {
    const [admin, friend] = devices(2);
    const drive = await albumWithMembers(admin, [M]);
    const [, remote] = await friend.drives.open(drive.key, { timeoutMs: 500 });
    await until(async () => (await remote!.readSmall("/members.json", 1e6)) !== undefined, {
      what: "friend has the registry",
    });
    const result = await removeAlbumMember(remote!, { memberKey: M, log: friend.log });
    expect(result[0]?.kind, "Trip: remove: replica refuses the write").toBe("write-failed");
    const still = parseRegistry((await drive.readSmall("/members.json", 1e6)) ?? null);
    expect(isEnrolled(still, M), "Trip: remove: Admin's registry keeps M").toBe(true);
  });
});

describe("rotate", () => {
  const M = "m".repeat(64);
  const N = "n".repeat(64);
  const device = json({ name: "Maya" });

  async function oldAlbum(admin: ReturnType<typeof devices>[number]) {
    const drive = await created(admin.drives, "f1", "Trip");
    await drive.put("/photos/a.jpg", Buffer.from("photo-a"), { metadata: { sha256: "aa" } });
    await drive.put("/thumbs/a.jpg", Buffer.from("thumb-a"));
    await drive.put(
      "/members.json",
      json({
        version: 1,
        members: {
          [M]: { key: M, name: "Ben", addedAt: 1 },
          [N]: { key: N, name: "Cy", addedAt: 2 },
        },
      }),
    );
    await drive.put(
      "/removed.json",
      json({ version: 1, removed: { [`${M}:1`]: { at: 1 }, [`${"z".repeat(64)}:1`]: { at: 2 } } }),
    );
    return drive;
  }

  const ports = (d: ReturnType<typeof devices>[number]) => ({
    drives: d.drives,
    log: d.log,
    openTimeoutMs: 500,
  });

  it("an album moves to a new key and keeps its photos, members and tombstones", async () => {
    const [admin] = devices(1);
    const old = await oldAlbum(admin);
    const [err, rotated] = await rotateAlbum(ports(admin), {
      record: { id: "f1", name: "Trip", shareKey: old.key },
      ownDrive: await admin.drives.openOwn(),
      device,
      inviteCode: "code-1",
      now: 42,
    });
    expect(err, "Trip: rotate: succeeds").toBeNull();
    expect(rotated!.shareKey, "Trip: rotate: the album moves to a new key").not.toBe(old.key);
    expect(Object.keys(rotated!), "Trip: rotate: result key order").toEqual([
      "shareKey",
      "driveKey",
      "invite",
      "earlier",
      "notice",
      "rotatedAt",
    ]);
    expect(rotated, "Trip: rotate: result").toMatchObject({
      driveKey: rotated!.shareKey,
      invite: { code: "code-1" },
      earlier: [
        { key: M, name: "Ben" },
        { key: N, name: "Cy" },
      ],
      notice: { kind: "newKey" },
      rotatedAt: 42,
    });
    const target = await admin.drives.openOwn("album/f1");
    expect(target.key, "Trip: rotate: lands on album/<id>").toBe(rotated!.shareKey);
    expect(await target.readSmall("/folder.json", 1e6), "Trip: rotate: names the album").toBe(
      '{"version":1,"name":"Trip"}',
    );
    expect(await target.readSmall("/device.json", 1e6), "Trip: rotate: names the device").toBe(
      device.toString(),
    );
    expect(
      Buffer.from((await target.readBytes("/photos/a.jpg")) ?? []).toString(),
      "Trip: rotate: photo",
    ).toBe("photo-a");
    expect(
      Buffer.from((await target.readBytes("/thumbs/a.jpg")) ?? []).toString(),
      "Trip: rotate: thumb",
    ).toBe("thumb-a");
  });

  it("tombstones of people who are not earlier members are dropped", async () => {
    const [admin] = devices(1);
    const old = await oldAlbum(admin);
    await rotateAlbum(ports(admin), {
      record: { id: "f1", name: "Trip", shareKey: old.key },
      ownDrive: await admin.drives.openOwn(),
      device,
      inviteCode: "c",
      now: 1,
    });
    const target = await admin.drives.openOwn("album/f1");
    const removed = JSON.parse((await target.readSmall("/removed.json", 1e6)) ?? "{}");
    expect(Object.keys(removed.removed), "Trip: rotate: only earlier members' tombstones").toEqual([
      `${M}:1`,
    ]);
  });

  it("an album on the identity drive moves without releasing it", async () => {
    const [admin] = devices(1);
    const own = await admin.drives.openOwn();
    await own.put("/photos/a.jpg", Buffer.from("photo-a"));
    let released = 0;
    const counting: DriveStore = {
      ...admin.drives,
      release: async (d) => {
        if (d.key === own.key) released++;
        return admin.drives.release(d);
      },
    };
    const [err, rotated] = await rotateAlbum(
      { ...ports(admin), drives: counting },
      {
        record: { id: "f1", name: "Trip", shareKey: own.key },
        ownDrive: own,
        device,
        inviteCode: "c",
        now: 1,
      },
    );
    expect(err, "Trip: rotate: identity-drive album moves").toBeNull();
    expect(rotated!.shareKey, "Trip: rotate: new key").not.toBe(own.key);
    expect(released, "Trip: rotate: identity drive stays open").toBe(0);
  });

  it("a failed copy returns an error, and running it again finishes the move", async () => {
    const [admin] = devices(1);
    const old = await oldAlbum(admin);
    const record = { id: "f1", name: "Trip", shareKey: old.key };
    const own = await admin.drives.openOwn();
    let failures = 1;
    const flaky: DriveStore = {
      ...admin.drives,
      openOwn: async (ns) => {
        const drive = await admin.drives.openOwn(ns);
        if (ns !== "album/f1") return drive;
        return {
          ...drive,
          key: drive.key,
          put: async (...args: Parameters<Drive["put"]>) => {
            if (failures-- > 0) throw new Error("disk full");
            return drive.put(...args);
          },
        } as Drive;
      },
    };
    const first = await rotateAlbum(
      { ...ports(admin), drives: flaky },
      { record, ownDrive: own, device, inviteCode: "c", now: 1 },
    );
    expect(first, "Trip: rotate: failure is returned").toEqual([
      { kind: "rotate-failed", message: "disk full" },
      null,
    ]);
    expect(record.shareKey, "Trip: rotate: record is untouched").toBe(old.key);
    const [err, rotated] = await rotateAlbum(ports(admin), {
      record,
      ownDrive: own,
      device,
      inviteCode: "c",
      now: 2,
    });
    expect(err, "Trip: rotate: second run succeeds").toBeNull();
    const target = await admin.drives.openOwn("album/f1");
    expect(rotated!.shareKey, "Trip: rotate: same new key").toBe(target.key);
    expect(
      Buffer.from((await target.readBytes("/photos/a.jpg")) ?? []).toString(),
      "Trip: rotate: photo",
    ).toBe("photo-a");
  });

  it("an old drive that cannot be opened is an error value", async () => {
    const [admin] = devices(1);
    const own = await admin.drives.openOwn();
    const unreachable: DriveStore = {
      ...admin.drives,
      open: async () => [new Error("drive not ready"), null],
    };
    const [err, rotated] = await rotateAlbum(
      { ...ports(admin), drives: unreachable },
      {
        record: { id: "f1", name: "Trip", shareKey: "ab".repeat(32) },
        ownDrive: own,
        device,
        inviteCode: "c",
        now: 1,
      },
    );
    expect(err, "Trip: rotate: open failure").toEqual({
      kind: "rotate-failed",
      message: "drive not ready",
    });
    expect(rotated, "Trip: rotate: nothing returned").toBeNull();
  });
});
