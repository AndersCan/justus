/**
 * The DriveStore contract (#200): behaviour of Corestore and Hyperdrive that
 * the app relies on, written once and run against every implementation.
 *
 * Portable on purpose: no test-runner or Node built-in imports, so esbuild can bundle
 * it for Bare. A runtime supplies a {@link DriveWorld} and a `Check`.
 */
import type { Drive, DriveStore } from "../../src/ports/drive-store.ts";
import { eventually, type Check } from "../p2p-scenarios.ts";

export type DriveNode = {
  /** The current store; replaced by {@link DriveNode.restart}. */
  readonly store: DriveStore;
  /** Joins this node to the world's network so it replicates with the other connected nodes. */
  connect(): Promise<void>;
  /** Drops this node off the network; its store keeps working locally. */
  disconnect(): Promise<void>;
  /** Closes the store and opens a new one on the same storage. */
  restart(): Promise<DriveStore>;
};

export type DriveWorld = {
  /** A ready node. It is isolated until `connect()`. */
  node(): Promise<DriveNode>;
  close(): Promise<void>;
};

export type DriveCase = {
  name: string;
  run(world: DriveWorld, t: Check): Promise<void>;
};

const bytes = (s: string) => Buffer.from(s, "utf8");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function openOk(store: DriveStore, key: string, timeoutMs: number, t: Check): Promise<Drive> {
  const [err, drive] = await store.open(key, { timeoutMs });
  t.noErr([err], `open ${key.slice(0, 8)}`);
  if (!drive) throw new Error("open returned no drive");
  return drive;
}

/** Two connected nodes: `a` owns a drive, `b` opens it by key. */
async function pair(world: DriveWorld, t: Check) {
  const a = await world.node();
  const b = await world.node();
  await a.connect();
  await b.connect();
  const own = await a.store.openOwn("folder/x");
  const remote = await openOk(b.store, own.key, 10_000, t);
  return { a, b, own, remote };
}

async function paths(drive: Drive): Promise<string[]> {
  const found: string[] = [];
  for await (const entry of drive.list("/")) found.push(entry.path);
  return found;
}

/** `a` owns a drive with /x, /y and /deleted.json; `b` has read all three. */
async function keeperSetup(world: DriveWorld, t: Check) {
  const { a, b, own, remote } = await pair(world, t);
  await own.put("/x", bytes("photo"));
  await own.put("/y", bytes("other"));
  await own.put("/deleted.json", bytes("note"));
  for (const [path, text] of [
    ["/x", "photo"],
    ["/y", "other"],
    ["/deleted.json", "note"],
  ] as const) {
    await eventually(
      () => remote.readSmall(path, 10, { timeoutMs: 500 }),
      (v) => v === text,
      `b reads ${path}`,
    );
  }
  return { a, b, own, remote };
}

export const cases: DriveCase[] = [
  {
    name: "D1 put round-trips through readBytes and readSmall; a missing path is undefined",
    async run(world, t) {
      const { store } = await world.node();
      const drive = await store.openOwn();
      await drive.put("/a.txt", bytes("héllo ✓"));
      t.eq(
        Buffer.from((await drive.readBytes("/a.txt")) ?? []).toString("utf8"),
        "héllo ✓",
        "bytes",
      );
      t.eq(await drive.readSmall("/a.txt", 100), "héllo ✓", "utf8 text");
      t.eq(await drive.readBytes("/missing"), undefined, "missing bytes");
      t.eq(await drive.readSmall("/missing", 100), undefined, "missing text");
    },
  },
  {
    name: "D2b list yields entries in path order, whatever the insertion order",
    async run(world, t) {
      const { store } = await world.node();
      const drive = await store.openOwn();
      for (const path of ["/d/b", "/d/c", "/d/a", "/d/a/z", "/d/B"])
        await drive.put(path, bytes("x"));
      const found = [];
      for await (const entry of drive.list("/d")) found.push(entry.path);
      t.eq(found, ["/d/B", "/d/a", "/d/a/z", "/d/b", "/d/c"], "sorted by path bytes");
    },
  },
  {
    name: "D2 list yields path, real size and metadata for entries under the dir",
    async run(world, t) {
      const { store } = await world.node();
      const drive = await store.openOwn();
      await drive.put("/photos/b.jpg", bytes("abc"));
      await drive.put("/photos/a.jpg", bytes("hello"), { metadata: { name: "a.jpg", n: 1 } });
      await drive.put("/other/c.jpg", bytes("zz"));
      const found = [];
      for await (const e of drive.list("/photos")) found.push(e);
      found.sort((x, y) => x.path.localeCompare(y.path));
      t.eq(
        found,
        [
          { path: "/photos/a.jpg", size: 5, metadata: { name: "a.jpg", n: 1 } },
          { path: "/photos/b.jpg", size: 3, metadata: {} },
        ],
        "entries",
      );
    },
  },
  {
    name: "D3 del removes the path from reads and lists",
    async run(world, t) {
      const { store } = await world.node();
      const drive = await store.openOwn();
      await drive.put("/photos/a.jpg", bytes("hello"));
      await drive.del("/photos/a.jpg");
      t.eq(await drive.readBytes("/photos/a.jpg"), undefined, "read");
      const found = [];
      for await (const e of drive.list("/photos")) found.push(e);
      t.eq(found, [], "list");
    },
  },
  {
    name: "D4 onChange fires on local put and del, and stops after unsubscribe",
    async run(world, t) {
      const { store } = await world.node();
      const drive = await store.openOwn();
      let n = 0;
      const off = drive.onChange(() => n++);
      await drive.put("/a", bytes("1"));
      await eventually(
        async () => n,
        (v) => v >= 1,
        "put fired",
      );
      const afterPut = n;
      await drive.del("/a");
      await eventually(
        async () => n,
        (v) => v > afterPut,
        "del fired",
      );
      off();
      const settled = n;
      await drive.put("/b", bytes("2"));
      await sleep(200);
      t.eq(n, settled, "no calls after unsubscribe");
    },
  },
  {
    name: "D5 onChange fires on a node for a drive another node writes",
    async run(world, t) {
      const { own, remote } = await pair(world, t);
      let n = 0;
      remote.onChange(() => n++);
      await own.put("/a", bytes("1"));
      await eventually(
        async () => n,
        (v) => v >= 1,
        "remote change",
      );
      t.eq(
        await eventually(
          () => remote.readSmall("/a", 10),
          (v) => v === "1",
          "replicated",
        ),
        "1",
        "content",
      );
    },
  },
  {
    name: "D6 open is shared per key: concurrent and repeated opens work, release is ref-counted",
    async run(world, t) {
      const { a, b, own, remote } = await pair(world, t);
      await own.put("/a", bytes("hi"));
      const [one, two] = await Promise.all([
        openOk(b.store, own.key, 10_000, t),
        openOk(b.store, own.key, 10_000, t),
      ]);
      const three = await openOk(b.store, own.key, 10_000, t);
      for (const d of [one, two, three]) {
        t.eq(
          await eventually(
            () => d.readSmall("/a", 10),
            (v) => v === "hi",
            "read",
          ),
          "hi",
          "handle reads",
        );
      }
      await b.store.release(one);
      await b.store.release(two);
      await b.store.release(remote);
      t.eq(await three.readSmall("/a", 10), "hi", "last handle still reads");
      await b.store.release(three);
      const again = await openOk(b.store, own.key, 10_000, t);
      t.eq(
        await eventually(
          () => again.readSmall("/a", 10),
          (v) => v === "hi",
          "reopen",
        ),
        "hi",
        "reopened",
      );
      t.ok(a.store, "owner untouched");
    },
  },
  {
    name: "D6b releasing every handle on a node leaves the store usable",
    async run(world, t) {
      const { b, own, remote } = await pair(world, t);
      await own.put("/a", bytes("hi"));
      const identity = await b.store.openOwn();
      const folder = await b.store.openOwn("folder/y");
      await b.store.release(remote);
      await b.store.release(identity);
      await b.store.release(folder);
      const fresh = await b.store.openOwn("folder/z");
      await fresh.put("/b", bytes("ok"));
      t.eq(await fresh.readSmall("/b", 10), "ok", "new own drive reads and writes");
      const again = await openOk(b.store, own.key, 10_000, t);
      t.eq(
        await eventually(
          () => again.readSmall("/a", 10),
          (v) => v === "hi",
          "reopen",
        ),
        "hi",
        "remote drive reopens",
      );
      const reopenedIdentity = await b.store.openOwn();
      t.eq(reopenedIdentity.key, identity.key, "identity key is stable");
    },
  },
  {
    /** Hyperdrive 13.3.3 opens the header with { wait: false }, so ready() never waits for a peer: an unserved key opens at once, empty, and fills in once a peer that has it connects. The timeout only guards a ready() that really stalls. */
    name: "D7 open of an unserved key resolves promptly and empty, then fills in once the owner connects",
    async run(world, t) {
      const a = await world.node();
      const b = await world.node();
      const c = await world.node();
      await a.connect();
      await b.connect();
      const served = await c.store.openOwn();
      await served.put("/a", bytes("late"));
      const started = Date.now();
      const drive = await openOk(b.store, served.key, 300, t);
      t.ok(Date.now() - started < 1500, "returns promptly");
      t.eq(drive.stats().length, 0, "nothing replicated yet");
      t.eq(await drive.readSmall("/a", 10), undefined, "empty before the owner connects");
      await c.connect();
      t.eq(
        await eventually(
          () => drive.readSmall("/a", 10),
          (v) => v === "late",
          "served",
        ),
        "late",
        "filled in",
      );
    },
  },
  {
    name: "D8 namespaces map to stable keys across a restart; open of the identity key returns the identity drive",
    async run(world, t) {
      const node = await world.node();
      const identity = await node.store.openOwn();
      await identity.put("/device.json", bytes("{}"));
      const folder = await node.store.openOwn("folder/x");
      const member = await node.store.openOwn("member/y");
      t.ok(new Set([identity.key, folder.key, member.key]).size === 3, "distinct keys");
      const viaKey = await openOk(node.store, identity.key, 1_000, t);
      t.eq(await viaKey.readSmall("/device.json", 10), "{}", "legacy open by identity key");
      const store = await node.restart();
      t.eq((await store.openOwn("folder/x")).key, folder.key, "folder key");
      t.eq((await store.openOwn("member/y")).key, member.key, "member key");
      t.eq((await store.openOwn()).key, identity.key, "identity key");
    },
  },
  {
    name: "D8b open(key) then openOwn(namespace) after a restart share one handle, in either order and concurrently",
    async run(world, t) {
      const node = await world.node();
      const first = await node.store.openOwn("folder/x");
      await first.put("/a", bytes("hi"));
      let store = await node.restart();
      const viaKey = await openOk(store, first.key, 1_000, t);
      const own = await store.openOwn("folder/x");
      t.eq(own.key, first.key, "same key");
      t.eq(await own.readSmall("/a", 10), "hi", "reads after open then openOwn");
      store = await node.restart();
      const [keyed, owned] = await Promise.all([
        openOk(store, first.key, 1_000, t),
        store.openOwn("folder/x"),
      ]);
      t.eq(await keyed.readSmall("/a", 10), "hi", "concurrent open reads");
      t.eq(await owned.readSmall("/a", 10), "hi", "concurrent openOwn reads");
      t.ok(viaKey.key === first.key, "first handle key");
    },
  },
  {
    name: "D8c releasing a stale handle leaves the reopened drive open",
    async run(world, t) {
      const { store } = await world.node();
      const stale = await store.openOwn("folder/x");
      await stale.put("/a", bytes("hi"));
      await store.release(stale);
      const fresh = await store.openOwn("folder/x");
      await store.release(stale);
      t.eq(await fresh.readSmall("/a", 10), "hi", "fresh handle still reads");
    },
  },
  {
    name: "D9b readSmall over the bound returns undefined without downloading the blob",
    async run(world, t) {
      const { a, own, remote } = await pair(world, t);
      await own.put("/big", bytes("x".repeat(100)));
      await eventually(
        async () => {
          const found = [];
          for await (const entry of remote.list("/")) found.push(entry.path);
          return found;
        },
        (paths) => paths.includes("/big"),
        "entry replicated",
      );
      await a.disconnect();
      const outcome = await Promise.race([
        remote.readSmall("/big", 10),
        sleep(2_000).then(() => "hung"),
      ]);
      t.eq(outcome, undefined, "answered from the entry size alone");
    },
  },
  {
    name: "D9 readSmall is undefined for an entry larger than the bound",
    async run(world, t) {
      const { store } = await world.node();
      const drive = await store.openOwn();
      await drive.put("/big", bytes("x".repeat(100)));
      t.eq(await drive.readSmall("/big", 10), undefined, "over bound");
      t.eq((await drive.readSmall("/big", 100))?.length, 100, "at bound");
    },
  },
  {
    name: "D10 createReadStream on another node streams the bytes the owner wrote",
    async run(world, t) {
      const { own, remote } = await pair(world, t);
      await own.put("/photos/p", bytes("stream me"));
      await eventually(
        async () => remote.readBytes("/photos/p"),
        (v) => v !== undefined,
        "replicated",
      );
      const chunks: Uint8Array[] = [];
      await new Promise<void>((resolve, reject) => {
        const s = remote.createReadStream("/photos/p");
        s.on("data", (c: Uint8Array) => chunks.push(c));
        s.on("end", () => resolve());
        s.on("error", reject);
      });
      t.eq(Buffer.concat(chunks).toString("utf8"), "stream me", "streamed");
    },
  },
  {
    name: "D11 a node cannot write a drive it does not own, and the rejected write leaves no trace",
    async run(world, t) {
      const { own, remote } = await pair(world, t);
      await own.put("/a", bytes("1"));
      await eventually(
        () => remote.readSmall("/a", 10),
        (v) => v === "1",
        "replicated",
      );
      const putFailed = await remote.put("/b", bytes("x")).then(
        () => false,
        () => true,
      );
      const delFailed = await remote.del("/a").then(
        () => false,
        () => true,
      );
      t.ok(putFailed, "put rejects");
      t.ok(delFailed, "del rejects");
      t.eq(await remote.readSmall("/b", 10), undefined, "no local copy of the rejected put");
      t.eq(await remote.readSmall("/a", 10), "1", "rejected del removed nothing");
    },
  },
  {
    name: "D12 a third node gets a drive from a peer that holds it while the owner is offline",
    async run(world, t) {
      const { a, own, remote } = await pair(world, t);
      await own.put("/a", bytes("relay"));
      await eventually(
        () => remote.readSmall("/a", 10),
        (v) => v === "relay",
        "b holds the data",
      );
      await a.disconnect();
      const c = await world.node();
      await c.connect();
      const viaB = await openOk(c.store, own.key, 10_000, t);
      t.eq(
        await eventually(
          () => viaB.readSmall("/a", 10),
          (v) => v === "relay",
          "relayed",
          15_000,
        ),
        "relay",
        "content from b",
      );
    },
  },
  {
    name: "D13 a released handle rejects further use, and its listeners stop firing",
    async run(world, t) {
      const { store } = await world.node();
      const drive = await store.openOwn("folder/x");
      let n = 0;
      drive.onChange(() => n++);
      await store.release(drive);
      const putFailed = await drive.put("/a", bytes("1")).then(
        () => false,
        () => true,
      );
      t.ok(putFailed, "put on a released handle rejects");
      const again = await store.openOwn("folder/x");
      await again.put("/b", bytes("2"));
      await sleep(200);
      t.eq(n, 0, "released handle's listener never fires");
      t.eq(await again.readSmall("/b", 10), "2", "reopened handle works");
    },
  },
  {
    name: "D14 restarting invalidates the old store's handles; the data survives",
    async run(world, t) {
      const node = await world.node();
      const drive = await node.store.openOwn("folder/x");
      await drive.put("/a", bytes("1"));
      const store = await node.restart();
      const putFailed = await drive.put("/b", bytes("2")).then(
        () => false,
        () => true,
      );
      t.ok(putFailed, "put on a handle of the old store rejects");
      t.eq(await (await store.openOwn("folder/x")).readSmall("/a", 10), "1", "data survives");
    },
  },
  {
    name: "D15 stats().peers counts the connected nodes replicating the drive, and drops to 0 when offline",
    async run(world, t) {
      const { a, own, remote } = await pair(world, t);
      const bystander = await world.node();
      await bystander.connect();
      await eventually(
        async () => own.stats().peers,
        (v) => v === 1,
        "owner sees only the node replicating the drive",
      );
      await sleep(500);
      t.eq(own.stats().peers, 1, "a connected node that never opened the drive is not a peer");
      await eventually(
        async () => remote.stats().peers,
        (v) => v >= 1,
        "reader sees the owner",
      );
      await a.disconnect();
      await eventually(
        async () => own.stats().peers,
        (v) => v === 0,
        "no peers once offline",
        15_000,
      );
    },
  },
  {
    name: "D16 readSmall with a timeout settles when the blob cannot be fetched",
    async run(world, t) {
      const { a, own, remote } = await pair(world, t);
      await own.put("/big", bytes("x".repeat(100)));
      await eventually(
        async () => {
          const found = [];
          for await (const entry of remote.list("/")) found.push(entry.path);
          return found;
        },
        (paths) => paths.includes("/big"),
        "entry replicated",
      );
      await a.disconnect();
      const started = Date.now();
      const outcome = await Promise.race([
        remote.readSmall("/big", 1_000, { timeoutMs: 200 }).then(
          (v) => v,
          () => undefined,
        ),
        sleep(2_000).then(() => "hung"),
      ]);
      t.ok(outcome !== "hung", "settled");
      t.ok(Date.now() - started < 1_500, "bounded by the timeout");
    },
  },
  {
    name: "D17 discoveryKeyOf(key) is the opened drive's discoveryKey, before and after opening",
    async run(world, t) {
      const { store } = await world.node();
      const drive = await store.openOwn("folder/x");
      t.eq(store.discoveryKeyOf(drive.key), drive.discoveryKey, "own drive");
      const other = await world.node();
      const served = await other.store.openOwn();
      const before = store.discoveryKeyOf(served.key);
      const remote = await openOk(store, served.key, 1_000, t);
      t.eq(remote.discoveryKey, before, "remote drive");
    },
  },
  {
    name: "D18 update resolves on a drive with nobody to ask",
    async run(world, t) {
      const { store } = await world.node();
      const drive = await store.openOwn();
      const outcome = await Promise.race([
        drive.update().then(() => "done"),
        sleep(5_000).then(() => "hung"),
      ]);
      t.eq(outcome, "done", "update settles");
    },
  },
  {
    name: "D19 clear drops this node's copy of a file's bytes; the entry stays and a peer's copy comes back",
    async run(world, t) {
      const { a, b, own, remote } = await pair(world, t);
      await own.put("/a", bytes("hi"));
      await eventually(
        () => remote.readSmall("/a", 10, { timeoutMs: 500 }),
        (v) => v === "hi",
        "b reads /a",
      );
      await b.disconnect();
      await a.disconnect();
      await own.clear("/a");
      t.eq(await own.readSmall("/a", 10, { timeoutMs: 500 }), undefined, "bytes gone");
      const found = [];
      for await (const entry of own.list("/")) found.push(entry.path);
      t.eq(found, ["/a"], "entry stays");
      await b.connect();
      await a.connect();
      await eventually(
        () => own.readSmall("/a", 10, { timeoutMs: 500 }),
        (v) => v === "hi",
        "bytes come back from the peer",
      );
    },
  },
  {
    name: "D20 purge deletes this node's copy of a remote drive; the owner still serves it",
    async run(world, t) {
      const { a, b, own, remote } = await pair(world, t);
      await own.put("/a", bytes("hi"));
      await eventually(
        () => remote.readSmall("/a", 10, { timeoutMs: 500 }),
        (v) => v === "hi",
        "b reads /a",
      );
      await b.disconnect();
      await b.store.purge(remote.key);
      const readFailed = await remote.readSmall("/a", 10).then(
        () => false,
        () => true,
      );
      t.ok(readFailed, "purged handle rejects");
      const store = await b.restart();
      const [err, reopened] = await store.open(own.key, { timeoutMs: 1_000 });
      t.noErr([err], "reopen purged key");
      if (!reopened) throw new Error("no drive");
      const found = [];
      for await (const entry of reopened.list("/")) found.push(entry.path);
      t.eq(found, [], "reopened key lists nothing");
      await b.connect();
      await a.connect();
      await eventually(
        () => reopened.readSmall("/a", 10, { timeoutMs: 500 }),
        (v) => v === "hi",
        "data fills in again",
      );
    },
  },
  {
    name: "D21 purge of an own drive empties it after a restart and leaves other drives usable",
    async run(world, t) {
      const node = await world.node();
      const doomed = await node.store.openOwn("folder/x");
      const kept = await node.store.openOwn("folder/y");
      await doomed.put("/a", bytes("1"));
      await kept.put("/b", bytes("2"));
      await node.store.purge(doomed.key);
      const store = await node.restart();
      const again = await store.openOwn("folder/x");
      t.eq(again.key, doomed.key, "same key");
      const found = [];
      for await (const entry of again.list("/")) found.push(entry.path);
      t.eq(found, [], "emptied");
      const other = await store.openOwn("folder/y");
      t.eq(await other.readSmall("/b", 10), "2", "other drive intact");
      await again.put("/c", bytes("3"));
      t.eq(await again.readSmall("/c", 10), "3", "purged drive writable again");
    },
  },
  {
    name: "D22 a copy at version v hides a file put after v, and refuses writes",
    async run(world, t) {
      const { store } = await world.node();
      const drive = await store.openOwn("folder/x");
      await drive.put("/a", bytes("1"));
      const v = drive.version();
      await drive.put("/b", bytes("2"));
      const [err, copy] = await store.openAt(drive.key, v, { timeoutMs: 5_000 });
      t.noErr([err], "openAt");
      if (!copy) throw new Error("no copy");
      t.eq(copy.version(), v, "copy version");
      t.eq(await copy.readSmall("/a", 10), "1", "earlier file");
      t.eq(await copy.readSmall("/b", 10), undefined, "later file hidden");
      const found = [];
      for await (const e of copy.list("/")) found.push(e.path);
      t.eq(found, ["/a"], "list at v");
      t.eq(await drive.readSmall("/b", 10), "2", "live drive keeps the later file");
      const failed = await Promise.all([
        copy.put("/c", bytes("3")).then(
          () => false,
          (e: Error) => e.message === "read-only copy",
        ),
        copy.del("/a").then(
          () => false,
          (e: Error) => e.message === "read-only copy",
        ),
        copy.clear("/a").then(
          () => false,
          (e: Error) => e.message === "read-only copy",
        ),
      ]);
      t.eq(failed, [true, true, true], "put, del and clear throw");
    },
  },
  {
    name: "D23 a copy opened on a node that never read the drive lists and reads a photo put before v",
    async run(world, t) {
      const { own, b } = await pair(world, t);
      await own.put("/photos/p", bytes("old photo"));
      const v = own.version();
      await own.put("/photos/q", bytes("new photo"));
      const c = await world.node();
      await c.connect();
      const [err, copy] = await c.store.openAt(own.key, v, { timeoutMs: 20_000 });
      t.noErr([err], "openAt on c");
      if (!copy) throw new Error("no copy");
      t.eq(
        await eventually(
          () => copy.readSmall("/photos/p", 20, { timeoutMs: 1_000 }),
          (x) => x === "old photo",
          "bytes at v",
          30_000,
        ),
        "old photo",
        "photo bytes",
      );
      const found = [];
      for await (const e of copy.list("/photos")) found.push(e.path);
      t.eq(found, ["/photos/p"], "later photo hidden");
      t.ok(b.store, "b untouched");
    },
  },
  {
    name: "D24 releasing a copy leaves the live drive readable and writable",
    async run(world, t) {
      const { store } = await world.node();
      const drive = await store.openOwn("folder/x");
      await drive.put("/a", bytes("1"));
      const [err, copy] = await store.openAt(drive.key, drive.version(), { timeoutMs: 5_000 });
      t.noErr([err], "openAt");
      if (!copy) throw new Error("no copy");
      await store.release(copy);
      t.eq(await drive.readSmall("/a", 10), "1", "live reads");
      await drive.put("/b", bytes("2"));
      t.eq(await drive.readSmall("/b", 10), "2", "live writes");
    },
  },
  {
    name: "D25 openAt past the reachable length gives an error value within the timeout, and the drive stays usable",
    async run(world, t) {
      const { store } = await world.node();
      const drive = await store.openOwn("folder/x");
      await drive.put("/a", bytes("1"));
      const started = Date.now();
      const [err, copy] = await store.openAt(drive.key, drive.version() + 5, { timeoutMs: 500 });
      t.ok(err !== null && copy === null, "error value");
      t.ok(Date.now() - started < 3_000, "bounded by the timeout");
      await drive.put("/b", bytes("2"));
      t.eq(await drive.readSmall("/b", 10), "2", "drive still writes");
    },
  },
  {
    name: "D26 openAt on a key this node already holds does not hang",
    async run(world, t) {
      const { b, own, remote } = await pair(world, t);
      await own.put("/a", bytes("1"));
      const v = own.version();
      await eventually(
        () => remote.readSmall("/a", 10),
        (x) => x === "1",
        "replicated",
      );
      const [err, copy] = await b.store.openAt(own.key, v, { timeoutMs: 10_000 });
      t.noErr([err], "openAt on a held key");
      if (!copy) throw new Error("no copy");
      t.eq(await copy.readSmall("/a", 10), "1", "copy reads");
      await b.store.release(copy);
      t.eq(await remote.readSmall("/a", 10), "1", "held handle still reads");
    },
  },
  {
    name: "D27 a copy holds a ref on the live drive: it closes only after the copy and the live handle are both released",
    async run(world, t) {
      const { store } = await world.node();
      const drive = await store.openOwn("folder/x");
      await drive.put("/a", bytes("1"));
      const [err, copy] = await store.openAt(drive.key, drive.version(), { timeoutMs: 5_000 });
      t.noErr([err], "openAt");
      if (!copy) throw new Error("no copy");
      await store.release(drive);
      t.eq(await drive.readSmall("/a", 10), "1", "copy still holds the live drive open");
      await store.release(copy);
      const closed = await drive.readSmall("/a", 10).then(
        () => false,
        () => true,
      );
      t.ok(closed, "live drive closed once the copy is released too");
    },
  },
  {
    name: "D28 signAsIdentity signs as the identity drive: verifyIdentity accepts it on another node and after a restart",
    async run(world, t) {
      const a = await world.node();
      const b = await world.node();
      const id = (await a.store.openOwn()).key;
      const msg = bytes("justus-device/v1:abc");
      const [err, sig] = await a.store.signAsIdentity(msg);
      t.noErr([err], "sign");
      if (!sig) throw new Error("no signature");
      t.ok(sig.publicKey !== id, "the public key is not the drive key");
      t.ok(b.store.verifyIdentity({ identityKey: id, ...sig, message: msg }), "verifies on b");
      const store = await a.restart();
      const [err2, again] = await store.signAsIdentity(msg);
      t.noErr([err2], "sign after restart");
      if (!again) throw new Error("no signature");
      t.eq(again.publicKey, sig.publicKey, "same public key after restart");
      t.eq((await store.openOwn()).key, id, "same identity drive");
      t.ok(store.verifyIdentity({ identityKey: id, ...again, message: msg }), "verifies again");
    },
  },
  {
    name: "D29 verifyIdentity refuses a signature that does not bind this message to this identity drive",
    async run(world, t) {
      const a = await world.node();
      const b = await world.node();
      const aId = (await a.store.openOwn()).key;
      const bId = (await b.store.openOwn()).key;
      const msg = bytes("justus-device/v1:abc");
      const [, aSig] = await a.store.signAsIdentity(msg);
      const [, bSig] = await b.store.signAsIdentity(msg);
      if (!aSig || !bSig) throw new Error("no signature");
      const base = { identityKey: aId, ...aSig, message: msg };
      const last = aSig.signature.endsWith("0") ? "1" : "0";
      const refused: Record<string, Parameters<DriveStore["verifyIdentity"]>[0]> = {
        "another message": { ...base, message: bytes("other") },
        "another identity key": { ...base, identityKey: bId },
        "another signer's own proof under this identity": {
          ...bSig,
          identityKey: aId,
          message: msg,
        },
        "a changed signature": { ...base, signature: aSig.signature.slice(0, -1) + last },
        "a bad public key": { ...base, publicKey: "zz" },
        "an empty signature": { ...base, signature: "" },
        "a short identity key": { ...base, identityKey: aId.slice(0, 63) },
      };
      for (const [label, proof] of Object.entries(refused)) {
        t.ok(a.store.verifyIdentity(proof) === false, `refused: ${label}`);
      }
      t.ok(a.store.verifyIdentity(base), "the genuine proof still verifies");
    },
  },
  {
    name: "D30 a keeper serves the kept file to a third node after the owner made later changes and went offline",
    async run(world, t) {
      const { a, own, remote } = await keeperSetup(world, t);
      t.noErr(await remote.keepOnly("/deleted.json"), "keepOnly");
      await own.del("/x");
      await eventually(
        async () => [remote.version(), await paths(remote)],
        (v) =>
          v[0] === own.version() &&
          JSON.stringify(v[1]) === JSON.stringify(["/deleted.json", "/y"]),
        "b caught up with a",
      );
      await a.disconnect();
      const c = await world.node();
      await c.connect();
      const viaB = await openOk(c.store, own.key, 10_000, t);
      t.eq(
        await eventually(
          () => viaB.readSmall("/deleted.json", 10, { timeoutMs: 500 }),
          (v) => v === "note",
          "note from b",
          15_000,
        ),
        "note",
        "the kept file",
      );
      t.eq(await paths(viaB), ["/deleted.json", "/y"], "no /x");
    },
  },
  {
    name: "D31 keepOnly drops this node's bytes of every other file, and they do not come back",
    async run(world, t) {
      const { a, remote } = await keeperSetup(world, t);
      t.noErr(await remote.keepOnly("/deleted.json"), "keepOnly");
      await a.disconnect();
      t.eq(await remote.readSmall("/y", 10, { timeoutMs: 500 }), undefined, "y bytes gone");
      t.eq(await remote.readSmall("/x", 10, { timeoutMs: 500 }), undefined, "x bytes gone");
      t.eq(await remote.readSmall("/deleted.json", 10), "note", "kept file stays");
      t.eq((await paths(remote)).includes("/y"), true, "entry stays");
      await a.connect();
      await sleep(2_000);
      await a.disconnect();
      t.eq(await remote.readSmall("/y", 10, { timeoutMs: 500 }), undefined, "y still gone");
    },
  },
  {
    name: "D32 keepOnly also drops the bytes of a file a later version deleted",
    async run(world, t) {
      const { a, b, own, remote } = await keeperSetup(world, t);
      const before = own.version();
      await own.del("/x");
      await eventually(
        async () => ({ version: remote.version(), found: await paths(remote) }),
        (v) => v.version === own.version() && !v.found.includes("/x"),
        "b has the delete",
      );
      t.noErr(await remote.keepOnly("/deleted.json"), "keepOnly");
      await a.disconnect();
      const [err, old] = await b.store.openAt(own.key, before, { timeoutMs: 2_000 });
      t.noErr([err], "openAt");
      t.eq(await old?.readSmall("/x", 10, { timeoutMs: 500 }), undefined, "old x bytes gone");
    },
  },
  {
    name: "D33 a keeper still serves after a restart",
    async run(world, t) {
      const { a, b, own, remote } = await keeperSetup(world, t);
      t.noErr(await remote.keepOnly("/deleted.json"), "keepOnly");
      await a.disconnect();
      const store = await b.restart();
      await b.connect();
      const again = await openOk(store, own.key, 10_000, t);
      t.noErr(await again.keepOnly("/deleted.json"), "keepOnly again");
      const c = await world.node();
      await c.connect();
      const viaB = await openOk(c.store, own.key, 10_000, t);
      t.eq(
        await eventually(
          () => viaB.readSmall("/deleted.json", 10, { timeoutMs: 500 }),
          (v) => v === "note",
          "note from b",
          15_000,
        ),
        "note",
        "the kept file",
      );
    },
  },
  {
    name: "D34 keepOnly keeps a file in the middle and drops the bytes written after it",
    async run(world, t) {
      const { a, remote } = await keeperSetup(world, t);
      t.noErr(await remote.keepOnly("/y"), "keepOnly");
      await a.disconnect();
      t.eq(await remote.readSmall("/y", 10), "other", "kept file stays");
      t.eq(await remote.readSmall("/x", 10, { timeoutMs: 500 }), undefined, "earlier file gone");
      t.eq(
        await remote.readSmall("/deleted.json", 10, { timeoutMs: 500 }),
        undefined,
        "later file gone",
      );
    },
  },
  {
    name: "D35 keepOnly returns an error for a missing path and for one already cleared",
    async run(world, t) {
      const { a, remote, own } = await keeperSetup(world, t);
      const [missingErr] = await remote.keepOnly("/nope");
      t.eq(missingErr instanceof Error, true, "missing path is an error value");
      await own.put("/z", bytes("zed"));
      await eventually(
        () => remote.readSmall("/z", 10, { timeoutMs: 500 }),
        (v) => v === "zed",
        "b reads /z",
      );
      await a.disconnect();
      await remote.clear("/z");
      const [clearedErr] = await remote.keepOnly("/z");
      t.eq(clearedErr instanceof Error, true, "cleared path is an error value");
      t.eq(await remote.readSmall("/y", 10, { timeoutMs: 500 }), "other", "nothing was dropped");
    },
  },
  {
    name: "D36 keepOnly keeps a file spanning several blocks and a third node can read it",
    async run(world, t) {
      const { a, own, remote } = await pair(world, t);
      const big = Buffer.alloc(300 * 1024, "q");
      await own.put("/before", bytes("b"));
      await own.put("/big", big);
      await own.put("/after", bytes("c"));
      await eventually(
        async () => (await remote.readBytes("/big"))?.length,
        (v) => v === big.length,
        "b has big",
        15_000,
      );
      await eventually(
        () => remote.readSmall("/after", 10, { timeoutMs: 500 }),
        (v) => v === "c",
        "b has after",
      );
      t.noErr(await remote.keepOnly("/big"), "keepOnly");
      await a.disconnect();
      t.eq(await remote.readSmall("/after", 10, { timeoutMs: 500 }), undefined, "after gone");
      const c = await world.node();
      await c.connect();
      const viaB = await openOk(c.store, own.key, 10_000, t);
      const got = await eventually(
        async () => (await viaB.readBytes("/big"))?.length,
        (v) => v === big.length,
        "big from b",
        20_000,
      );
      t.eq(got, big.length, "whole multi-block file served");
    },
  },
];
