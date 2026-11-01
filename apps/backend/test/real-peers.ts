/**
 * Harness for real-swarm tests: real Corestore, Hyperdrive, Hyperswarm (on a
 * `hyperdht/testnet`), the real protomux identity greeting, real node fs. Only
 * the loopback server is a stand-in. Use it for any behaviour that depends on
 * how the p2p libraries actually behave (#200): a fake would encode our
 * assumptions instead of checking them.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Corestore from "corestore";
import Hyperdrive from "hyperdrive";
import Hyperswarm from "hyperswarm";
import createTestnet from "hyperdht/testnet";
import { createPhotoStore, type PhotoStore, type PhotoStoreDeps } from "../src/photo-store.ts";

export type PhotoChanged = Parameters<PhotoStoreDeps["onChanged"]>[0];
export type SyncStatus = Awaited<ReturnType<PhotoStore["status"]>>;
import { makeFakeDeps } from "./fake-drive.ts";
import { formatP2pEvent, type P2pEvent } from "../src/p2p-log.ts";

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

export async function realNet(): Promise<Net> {
  const testnet = await createTestnet(3);
  const dirs: string[] = [];
  const live = new Set<Peer>();

  async function peer(name: string, storageDir?: string): Promise<Peer> {
    const dir = storageDir ?? mkdtempSync(join(tmpdir(), `justus-real-${name}-`));
    if (!storageDir) dirs.push(dir);
    const changes: PhotoChanged[] = [];
    const events: P2pEvent[] = [];
    const deps = makeFakeDeps({
      storageDir: dir,
      cacheDir: join(dir, "cache"),
      deviceName: name,
      onChanged: (c) => changes.push(c),
      makeCorestore: (d) => new Corestore(d),
      makeDrive: (cs, key) => new Hyperdrive(cs, key),
      makeSwarm: () => new Hyperswarm({ bootstrap: testnet.bootstrap }),
      // The real protomux greeting, not the harness fake.
      greetPeer: undefined,
      driveOpenTimeoutMs: 10_000,
      // Capture events per peer; P2P_LOG=1 also prints them, tagged by device.
      log: (e: P2pEvent) => {
        events.push(e);
        if (process.env.P2P_LOG) console.log(`${name} ${formatP2pEvent(e)}`);
      },
    });
    mkdirSync(deps.cacheDir, { recursive: true });
    const store = createPhotoStore(deps);
    await store.ready();
    let stopped = false;
    const p: Peer = {
      name,
      storageDir: dir,
      store,
      changes,
      events,
      async stop() {
        if (stopped) return;
        stopped = true;
        live.delete(p);
        await store.close();
      },
    };
    live.add(p);
    return p;
  }

  return {
    bootstrap: testnet.bootstrap,
    peer,
    async destroy() {
      for (const p of Array.from(live)) await p.stop();
      await testnet.destroy();
      for (const d of dirs) rmSync(d, { recursive: true, force: true });
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
