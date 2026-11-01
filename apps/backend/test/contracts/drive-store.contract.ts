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
];
