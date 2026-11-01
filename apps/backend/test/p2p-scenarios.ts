/**
 * Every multi-device flow over a real swarm (#200), written once and run in
 * two runtimes: Node under vitest (`p2p-flows.integration.test.ts`) and the
 * Bare runtime with the real bare-* deps (`scripts/test-bare.mjs`). Sharing the
 * scenarios is what stops "works in Node, breaks in Bare" from drifting.
 *
 * Portable on purpose: no vitest, no `node:*` imports, so esbuild can bundle
 * it for Bare. A runtime supplies a {@link Net} (how peers are built) and a
 * {@link Check} (how assertions fail).
 */
import type { PhotoStore, PhotoStoreDeps } from "../src/photo-store.ts";
import type { P2pEvent } from "../src/p2p-log.ts";

export type PhotoChanged = Parameters<PhotoStoreDeps["onChanged"]>[0];
export type SyncStatus = Awaited<ReturnType<PhotoStore["status"]>>;

export type Peer = {
  name: string;
  storageDir: string;
  store: PhotoStore;
  changes: PhotoChanged[];
  /** Every structured p2p event this device logged (`src/p2p-log.ts`). */
  events: P2pEvent[];
  /** Closes the store, keeping its storage (a device going offline). */
  stop(): Promise<void>;
};

export type Net = {
  bootstrap: unknown[];
  /** Boots a device; pass `storageDir` of a stopped peer to restart it. */
  peer(name: string, storageDir?: string): Promise<Peer>;
  destroy(): Promise<void>;
};

/** Minimal assertions: each throws on failure. */
export type Check = {
  ok(cond: unknown, what: string): void;
  /** Deep equality by JSON shape. */
  eq(actual: unknown, expected: unknown, what: string): void;
  /** Asserts a `[error, value]` result carries no error. */
  noErr(result: readonly unknown[], what: string): void;
};

export function makeCheck(): Check {
  const fail = (m: string): never => {
    throw new Error(`assertion failed: ${m}`);
  };
  return {
    ok: (cond, what) => {
      if (!cond) fail(what);
    },
    eq: (actual, expected, what) => {
      const a = JSON.stringify(actual);
      const e = JSON.stringify(expected);
      if (a !== e) fail(`${what}: expected ${e}, got ${a}`);
    },
    noErr: (result, what) => {
      if (result[0]) fail(`${what}: ${String((result[0] as Error).message ?? result[0])}`);
    },
  };
}

/** Polls `probe` until `ok`, failing with the last value seen. */
export async function eventually<T>(
  probe: () => Promise<T>,
  ok: (v: T) => boolean,
  what: string,
  ms = 20_000,
): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (ok(v)) return v;
    if (Date.now() > end)
      throw new Error(`timed out waiting for ${what}; last: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

export const albumIn = async (store: PhotoStore, shareKey: string) =>
  (await store.folders()).folders.find((f) => f.shareKey === shareKey);

/** Admin creates an album with one photo; joiner joins and is approved,
 * all over the real swarm. */
export async function sharedAlbum(net: Net, adminName = "Phone", joinerName = "Desktop") {
  const admin = await net.peer(adminName);
  const joiner = await net.peer(joinerName);
  const created = await admin.store.createFolder("Shared");
  if (created[0]) throw created[0];
  const { id: folderId, shareKey } = created[1].folder;
  const setA = await admin.store.setActive(folderId);
  if (setA[0]) throw setA[0];
  const added = await admin.store.addBytes("a.jpg", new Uint8Array([211, 2, 3]));
  if (added[0]) throw added[0];
  const joined = await joiner.store.join(shareKey, "Shared");
  if (joined[0]) throw joined[0];
  const { requests } = await eventually(
    () => admin.store.requests(),
    (r) => r.requests.length === 1,
    "the join request on the Admin",
  );
  const responded = await admin.store.respond(folderId, requests[0].requesterKey, true);
  if (responded[0]) throw responded[0];
  const album = await eventually(
    () => albumIn(joiner.store, shareKey),
    (f) => f?.role === "member" && !f.pending,
    "the joiner's upgrade to member",
  );
  return { admin, joiner, folderId, shareKey, joinerFolderId: album!.id };
}

type Member = SyncStatus["members"][number];

export type Scenario = {
  name: string;
  run(net: Net, t: Check): Promise<void>;
};

export const scenarios: Scenario[] = [
  {
    name: "a Member's photo reaches the Admin",
    async run(net, t) {
      const { admin, joiner, joinerFolderId } = await sharedAlbum(net);
      t.noErr(
        await joiner.store.addBytes("b.jpg", new Uint8Array([9, 9, 9]), joinerFolderId),
        "add",
      );
      const seen = await eventually(
        () => admin.store.list(),
        (l) => l.some((p) => p.name === "b.jpg"),
        "the Member's photo on the Admin",
      );
      t.eq(
        seen.map((p) => p.name).sort((a, b) => a.localeCompare(b)),
        ["a.jpg", "b.jpg"],
        "Admin's photos",
      );
      // Sizes come from the real Hyperdrive entry shape, on both sides.
      t.eq(
        seen.find((p) => p.name === "b.jpg")?.size,
        3,
        "the Member's photo size as listed on the Admin",
      );
      t.ok(
        admin.changes.some((c) => c.cause === "add"),
        "Admin was pushed an add",
      );

      // The same flow must be diagnosable from logs alone (#200): a connection,
      // the identity exchange and the drive change each left an event.
      const opened = admin.events.find((e) => e.event === "conn.open");
      t.ok(typeof opened?.fields.conn === "number", "conn.open event with a conn id");
      const identity = admin.events.find(
        (e) => e.event === "identity.learned" && e.fields.new === true,
      );
      t.ok(typeof identity?.fields.conn === "number", "identity.learned names its conn");
      t.ok(
        /^[0-9a-f]{8}$/.test(String(identity?.fields.identity)),
        "identity.learned carries a short identity key",
      );
      t.ok(
        admin.events.some((e) => e.event === "drive.change" && Number(e.fields.length) > 0),
        "drive.change event with a length",
      );
      t.ok(
        admin.events.some((e) => e.event === "drive.open.ready"),
        "drive.open.ready event",
      );
      // The state dump names the live connection and its learned identity.
      const dump = admin.store.debugState() as {
        connections: { conn: number; identityKey: string | null }[];
      };
      t.ok(
        dump.connections.some((c) => c.identityKey !== null),
        "debugState lists a connection with its identity",
      );
    },
  },
  {
    name: "a photo the Admin adds after the join reaches the Member",
    async run(net, t) {
      const { admin, joiner } = await sharedAlbum(net);
      t.noErr(await admin.store.addBytes("c.jpg", new Uint8Array([7, 7])), "add");
      await eventually(
        () => joiner.store.list(),
        (l) => l.some((p) => p.name === "c.jpg"),
        "the Admin's new photo on the Member",
      );
    },
  },
  {
    name: "a removal on the Admin reaches the Member",
    async run(net, t) {
      const { admin, joiner } = await sharedAlbum(net);
      await eventually(
        () => joiner.store.list(),
        (l) => l.length === 1,
        "the Admin's photo on the Member",
      );
      const [photo] = await admin.store.list();
      t.noErr(await admin.store.remove(photo.id), "remove");
      await eventually(
        () => joiner.store.list(),
        (l) => l.length === 0,
        "the removal on the Member",
      );
      // A replicated change is pushed as a refresh; the web layer reloads on
      // any cause but "presence" (handle-message.ts), so the cause is not "remove".
      t.ok(
        joiner.changes.some((c) => c.cause !== "presence"),
        "Member was pushed a refresh",
      );
    },
  },
  {
    name: "presence: each side sees the other connected, then not once it leaves",
    async run(net, t) {
      const { admin, joiner, joinerFolderId } = await sharedAlbum(net);
      t.noErr(await joiner.store.setActive(joinerFolderId), "setActive");
      const other = (s: SyncStatus, self: string) => s.members.find((m: Member) => m.key !== self);
      await eventually(
        () => admin.store.status(),
        (s) => other(s, s.driveKey)?.connected === true,
        "the Member shown connected on the Admin",
      );
      await eventually(
        () => joiner.store.status(),
        (s) => other(s, s.driveKey)?.connected === true,
        "the Admin shown connected on the Member",
      );
      await joiner.stop();
      const after = await eventually(
        () => admin.store.status(),
        (s) => other(s, s.driveKey)?.connected === false,
        "the Member shown offline on the Admin",
      );
      t.ok(typeof other(after, after.driveKey)?.lastSeenAt === "number", "lastSeenAt is a number");
    },
  },
  {
    name: "restart: a Member comes back with its album, role and photos, and keeps syncing",
    async run(net, t) {
      const { admin, joiner, shareKey } = await sharedAlbum(net);
      await eventually(
        () => joiner.store.list({ all: true }),
        (l) => l.length === 1,
        "first sync",
      );
      await joiner.stop();

      const again = await net.peer("Desktop", joiner.storageDir);
      const album = await albumIn(again.store, shareKey);
      t.eq(album?.role, "member", "role after restart");
      t.ok(!album?.pending, "not pending after restart");
      t.eq(album?.name, "Shared", "name after restart");
      t.eq(
        (await again.store.list({ all: true })).map((p) => p.name),
        ["a.jpg"],
        "photos after restart",
      );

      t.noErr(await admin.store.addBytes("d.jpg", new Uint8Array([4, 4])), "add");
      await eventually(
        () => again.store.list({ all: true }),
        (l) => l.some((p) => p.name === "d.jpg"),
        "a photo added while restarting reaches the restarted Member",
      );
    },
  },
  {
    name: "restart: presence follows a peer whose connection key changed",
    async run(net) {
      const { admin, joiner } = await sharedAlbum(net);
      const other = (s: SyncStatus) => s.members.find((m: Member) => m.key !== s.driveKey);
      await eventually(
        () => admin.store.status(),
        (s) => other(s)?.connected === true,
        "online",
      );
      await joiner.stop();
      await eventually(
        () => admin.store.status(),
        (s) => other(s)?.connected === false,
        "offline",
      );
      await net.peer("Desktop", joiner.storageDir);
      await eventually(
        () => admin.store.status(),
        (s) => other(s)?.connected === true,
        "the restarted Member shown connected again",
      );
    },
  },
  {
    name: "restart: the Admin comes back and still serves its album",
    async run(net, t) {
      const { admin, joiner, folderId } = await sharedAlbum(net);
      await admin.stop();
      const again = await net.peer("Phone", admin.storageDir);
      t.noErr(await again.store.setActive(folderId), "setActive");
      t.noErr(await again.store.addBytes("e.jpg", new Uint8Array([5])), "add");
      await eventually(
        () => joiner.store.list({ all: true }),
        (l) => l.some((p) => p.name === "e.jpg"),
        "a photo from the restarted Admin on the Member",
      );
    },
  },
  {
    name: "a declined request leaves the joiner a pending reader and clears the inbox",
    async run(net, t) {
      const admin = await net.peer("Phone");
      const joiner = await net.peer("Desktop");
      const created = await admin.store.createFolder("Private");
      t.noErr(created, "createFolder");
      const { id: folderId, shareKey } = created[1]!.folder;
      t.noErr(await joiner.store.join(shareKey), "join");
      const { requests } = await eventually(
        () => admin.store.requests(),
        (r) => r.requests.length === 1,
        "the join request",
      );
      t.noErr(await admin.store.respond(folderId, requests[0].requesterKey, false), "respond");
      t.eq((await admin.store.requests()).requests, [], "inbox cleared");
      // Nothing upgrades the joiner: give replication a moment to prove it.
      await new Promise((r) => setTimeout(r, 1500));
      const album = await albumIn(joiner.store, shareKey);
      t.ok(album?.role !== "member", "declined joiner is not a member");
    },
  },
];
