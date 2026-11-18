import { describe, expect, it } from "vite-plus/test";
import { createHash } from "node:crypto";
import type { Drive, DriveStore, IdentityProof } from "../../src/ports/drive-store.ts";
import {
  addFakeNode,
  createFakeDriveStore,
  createFakeHub,
  setFakeNodeConnected,
} from "../fakes/fake-world.ts";
import { followAdmin, listsDigest, takeAdminRecords } from "../../src/albums/handover.ts";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const json = (value: unknown) => Buffer.from(JSON.stringify(value));
const members = (...keys: string[]) =>
  json({
    version: 1,
    members: Object.fromEntries(keys.map((k) => [k, { key: k, name: "x", addedAt: 1 }])),
  });

function store() {
  const hub = createFakeHub();
  const node = addFakeNode(hub);
  setFakeNodeConnected({ hub, node, connected: true });
  return createFakeDriveStore({ hub, node });
}

async function album(drives: DriveStore, ns: string, identity: string, list: Buffer | undefined) {
  const drive = await drives.openOwn(ns);
  await drive.put(
    "/device.json",
    json({
      identityKey: identity,
      identityPublicKey: "c".repeat(64),
      identitySig: "d".repeat(128),
    }),
  );
  if (list) await drive.put("/members.json", list);
  return drive;
}

const note = (to: Drive, identity: string) =>
  json({ version: 1, next: { key: to.key, identity, name: "Ben" }, at: 1 });

function ports(drives: DriveStore, byKey: Map<string, Drive>, verify = () => true) {
  const released: string[] = [];
  return {
    released,
    ports: {
      open: async (key: string): Promise<[Error, null] | [null, Drive]> => {
        const d = byKey.get(key);
        return d ? [null, d] : [new Error("not found"), null];
      },
      release: async (d: Drive) => {
        released.push(d.key);
      },
      verify: verify as (p: IdentityProof) => boolean,
      log: () => {},
    },
  };
}

describe("followAdmin", () => {
  const I1 = "1".repeat(64);
  const I2 = "2".repeat(64);
  const I3 = "3".repeat(64);

  async function setup() {
    const drives = store();
    const root = await drives.openOwn("root");
    const b = await album(drives, "b", I1, members());
    const c = await album(drives, "c", I2, members());
    await root.put("/members.json", members(b.key));
    await root.put("/admin.json", note(b, I1));
    await b.put("/members.json", members(c.key));
    await b.put("/admin.json", note(c, I2));
    const byKey = new Map([b, c].map((d) => [d.key, d]));
    return { drives, root, b, c, byKey };
  }
  const follow = (p: ReturnType<typeof ports>, root: Drive, chain: string[] = []) =>
    followAdmin(p.ports, { from: root, chain });

  it("follows root to B to C", async () => {
    const { drives, root, b, c, byKey } = await setup();
    const out = await follow(ports(drives, byKey), root);
    expect(out.hops.map((h) => h.drive.key)).toEqual([b.key, c.key]);
    expect(out.hops[0].next).toEqual({ key: b.key, identity: I1, name: "Ben" });
    expect(out.unsupported).toBe(false);
  });

  it("stops at a key the current list does not name, and tells nobody to release it", async () => {
    const { drives, root, b, byKey } = await setup();
    await b.put("/members.json", members());
    const p = ports(drives, byKey);
    const out = await follow(p, root);
    expect(out.hops.map((h) => h.drive.key)).toEqual([b.key]);
    expect(p.released).toEqual([]);
  });

  it("stops at a /device.json that names another identity, and releases that drive", async () => {
    const { drives, root, b, c, byKey } = await setup();
    await b.put("/admin.json", note(c, I3));
    const p = ports(drives, byKey);
    const out = await follow(p, root);
    expect(out.hops.map((h) => h.drive.key)).toEqual([b.key]);
    expect(p.released).toEqual([c.key]);
  });

  it("stops at a /device.json whose signature does not verify", async () => {
    const { drives, root, byKey } = await setup();
    const out = await follow(
      ports(drives, byKey, () => false),
      root,
    );
    expect(out.hops).toEqual([]);
  });

  it("stops at a next drive whose /members.json is not readable", async () => {
    const { drives, root, c, byKey } = await setup();
    const bare = await drives.openOwn("bare");
    await bare.put("/device.json", await c.readBytes("/device.json").then((x) => Buffer.from(x!)));
    await root.put("/members.json", members(bare.key));
    await root.put("/admin.json", note(bare, I2));
    byKey.set(bare.key, bare);
    expect((await follow(ports(drives, byKey), root)).hops).toEqual([]);
  });

  it("stops when the next drive does not open", async () => {
    const { drives, root, byKey } = await setup();
    byKey.clear();
    expect((await follow(ports(drives, byKey), root)).hops).toEqual([]);
  });

  it("stops at a cycle and at a key already in the chain", async () => {
    const { drives, root, b, c, byKey } = await setup();
    await c.put("/members.json", members(b.key));
    await c.put("/admin.json", note(b, I1));
    expect((await follow(ports(drives, byKey), root)).hops.map((h) => h.drive.key)).toEqual([
      b.key,
      c.key,
    ]);
    expect((await follow(ports(drives, byKey), root, [b.key])).hops).toEqual([]);
  });

  it("stops at a note that points back at the drive it started from", async () => {
    const { drives, root, c, byKey } = await setup();
    await c.put("/members.json", members(root.key));
    await c.put("/admin.json", note(root, I3));
    await root.put(
      "/device.json",
      json({ identityKey: I3, identityPublicKey: "c".repeat(64), identitySig: "d".repeat(128) }),
    );
    byKey.set(root.key, root);
    expect((await follow(ports(drives, byKey), root)).hops).toHaveLength(2);
  });

  it("stops at a note of version 2 and says so", async () => {
    const { drives, root, byKey } = await setup();
    await root.put("/admin.json", json({ version: 2, next: {} }));
    const out = await follow(ports(drives, byKey), root);
    expect(out).toEqual({ hops: [], unsupported: true });
  });

  it("stops without a note, and with a malformed one", async () => {
    const { drives, root, byKey } = await setup();
    await root.put("/admin.json", Buffer.from("{"));
    expect(await follow(ports(drives, byKey), root)).toEqual({ hops: [], unsupported: false });
    await root.del("/admin.json");
    expect((await follow(ports(drives, byKey), root)).hops).toEqual([]);
  });

  it("follows at most 16 Admins, counting the chain it was given", async () => {
    const drives = store();
    const byKey = new Map<string, Drive>();
    const all: Drive[] = [];
    for (let i = 0; i < 4; i++) {
      all.push(await album(drives, `d${i}`, String(i + 1).repeat(64), members()));
      byKey.set(all[i].key, all[i]);
    }
    for (let i = 0; i < 3; i++) {
      await all[i].put("/members.json", members(all[i + 1].key));
      await all[i].put("/admin.json", note(all[i + 1], String(i + 2).repeat(64)));
    }
    const room = Array.from({ length: 13 }, (_, i) => i.toString(16).padStart(64, "0"));
    const out = await followAdmin(ports(drives, byKey).ports, { from: all[0], chain: room });
    expect(out.hops).toHaveLength(3);
    const full = await followAdmin(ports(drives, byKey).ports, {
      from: all[0],
      chain: [...room, "f".repeat(64)],
    });
    expect(full.hops).toHaveLength(2);
  });
});

describe("takeAdminRecords", () => {
  const SELF = "b".repeat(64);
  const OTHER = "c".repeat(64);

  async function fill(drives: DriveStore, partial = false) {
    const from = await drives.openOwn("from");
    await from.put("/members.json", members(SELF, OTHER));
    await from.put("/viewers.json", json({ version: 1, viewers: {} }));
    await from.put("/folder.json", json({ version: 1, name: "Summer" }));
    if (!partial) {
      await from.put("/removed.json", json({ version: 1, removed: {} }));
      await from.put("/earlier.json", json({ version: 1, earlier: [] }));
      await from.put("/former.json", json({ version: 1, former: {} }));
    }
    return from;
  }

  it("copies the six files, drops self from the members and returns the digest of what it wrote", async () => {
    const drives = store();
    const from = await fill(drives);
    const to = await drives.openOwn("to");
    const [error, out] = await takeAdminRecords(from, to, { self: SELF, hash });
    expect(error).toBeNull();
    for (const path of [
      "/viewers.json",
      "/folder.json",
      "/removed.json",
      "/earlier.json",
      "/former.json",
    ]) {
      expect(await to.readSmall(path, 1000)).toBe(await from.readSmall(path, 1000));
    }
    expect(JSON.parse((await to.readSmall("/members.json", 1000))!).members).toEqual({
      [OTHER]: { key: OTHER, name: "x", addedAt: 1 },
    });
    expect(out?.digest).toBe(await listsDigest(to, hash));
  });

  it("writes /members.json last", async () => {
    const drives = store();
    const from = await fill(drives);
    const to = await drives.openOwn("to");
    const order: string[] = [];
    const spy = new Proxy(to, {
      get: (t, k) =>
        k === "put"
          ? async (path: string, bytes: Uint8Array) => {
              order.push(path);
              return t.put(path, bytes);
            }
          : (t as never)[k],
    });
    await takeAdminRecords(from, spy, { self: SELF, hash });
    expect(order.at(-1)).toBe("/members.json");
    expect(order).toHaveLength(6);
  });

  it("copies only the files the Admin's drive has, and still writes an empty member list", async () => {
    const drives = store();
    const from = await fill(drives, true);
    const to = await drives.openOwn("to");
    const [error] = await takeAdminRecords(from, to, { self: SELF, hash });
    expect(error).toBeNull();
    expect(await to.readSmall("/removed.json", 1000)).toBeUndefined();
    expect(await to.readSmall("/folder.json", 1000)).toBeDefined();
  });

  it("returns write-failed with the message when a write throws", async () => {
    const drives = store();
    const from = await fill(drives);
    const to = await drives.openOwn("to");
    const broken = {
      ...to,
      put: async () => {
        throw new Error("disk full");
      },
    } as Drive;
    const [error] = await takeAdminRecords(from, broken, { self: SELF, hash });
    expect(error).toEqual({ kind: "write-failed", message: expect.stringContaining("disk full") });
  });
});

describe("listsDigest", () => {
  it("changes with any one file, and reads a missing file as empty", async () => {
    const drives = store();
    const d = await drives.openOwn("d");
    const empty = await listsDigest(d, hash);
    await d.put("/folder.json", Buffer.from("x"));
    const one = await listsDigest(d, hash);
    expect(one).not.toBe(empty);
    await d.put("/folder.json", Buffer.from(""));
    expect(await listsDigest(d, hash)).toBe(empty);
    await d.put("/former.json", Buffer.from("x"));
    expect(await listsDigest(d, hash)).not.toBe(one);
  });

  it("tells a newline inside one file from a file boundary", async () => {
    const drives = store();
    const a = await drives.openOwn("a");
    const b = await drives.openOwn("b");
    await a.put("/viewers.json", Buffer.from("p\n"));
    await a.put("/folder.json", Buffer.from("q"));
    await b.put("/viewers.json", Buffer.from("p"));
    await b.put("/folder.json", Buffer.from("\nq"));
    expect(await listsDigest(a, hash)).not.toBe(await listsDigest(b, hash));
  });
});

describe("listsDigest after takeAdminRecords (plan step 3b)", () => {
  it("the next Admin's copy digests the same as the lists it was copied from", async () => {
    const drives = store();
    const SELF = "b".repeat(64);
    const from = await drives.openOwn("from");
    await from.put("/members.json", members(SELF, "c".repeat(64)));
    await from.put("/folder.json", json({ version: 1, name: "Summer" }));
    const to = await drives.openOwn("to");
    const [, out] = await takeAdminRecords(from, to, { self: SELF, hash });
    expect(await listsDigest(to, hash)).toBe(out?.digest);
  });
});
