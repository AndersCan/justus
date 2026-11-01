/**
 * Node harness for real-swarm tests: real Corestore, Hyperdrive, Hyperswarm (on
 * a `hyperdht/testnet`), the real protomux identity greeting, real node fs.
 * Only the loopback server is a stand-in. Use it for any behaviour that depends
 * on how the p2p libraries actually behave (#200): a fake would encode our
 * assumptions instead of checking them. The Bare twin is `test/bare/net.ts`.
 */
import { createHyperPeerNetwork } from "../src/adapters/hyper-peer-network.ts";
import { createHyperDriveStore, type HyperDriveStore } from "../src/adapters/hyper-drive-store.ts";
import type { P2pEvent } from "../src/p2p-log.ts";
import { createPhotoStore } from "../src/photo-store.ts";
import type { PeerEvent } from "../src/ports/peer-network.ts";
import type { DriveWorld } from "./contracts/drive-store.contract.ts";
import type { PeerNode, PeerWorld } from "./contracts/peer-network.contract.ts";
import { makeFakeDeps } from "./fake-drive.ts";
import { eventually, type Net, type Peer, type PhotoChanged } from "./p2p-scenarios.ts";
import Corestore from "corestore";
import createTestnet from "hyperdht/testnet";
import Hyperdrive from "hyperdrive";
import Hyperswarm from "hyperswarm";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export {
  albumIn,
  eventually,
  sharedAlbum,
  type Net,
  type Peer,
  type PhotoChanged,
  type SyncStatus,
} from "./p2p-scenarios.ts";

export async function realNet(): Promise<Net> {
  const testnet = await createTestnet(5);
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
      log: (e: P2pEvent) => events.push(e),
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

/** Real DriveStores on one `hyperdht/testnet`. Each `world()` is its own mesh. */
export async function realDriveWorlds(): Promise<{
  world(): DriveWorld;
  destroy(): Promise<void>;
}> {
  const testnet = await createTestnet(3);
  const dirs: string[] = [];
  const worlds: DriveWorld[] = [];

  function world(): DriveWorld {
    const topic = randomBytes(32);
    const nodes: Array<{ swarm?: any; store: HyperDriveStore }> = [];
    let connected = 0;

    return {
      async node() {
        const dir = mkdtempSync(join(tmpdir(), "justus-drive-"));
        dirs.push(dir);
        const me: { swarm?: any; store: HyperDriveStore } = {
          store: createHyperDriveStore(join(dir, "corestore")),
        };
        nodes.push(me);
        await me.store.ready();
        return {
          get store() {
            return me.store;
          },
          async connect() {
            const swarm = new Hyperswarm({ bootstrap: testnet.bootstrap });
            me.swarm = swarm;
            swarm.on("connection", (conn: any) => {
              me.store.replicate(conn);
              conn.on("error", () => {});
            });
            await swarm.join(topic, { server: true, client: true }).flushed();
            const peers = connected++;
            await eventually(
              async () => swarm.connections.size,
              (n) => n >= peers,
              "mesh connected",
              10_000,
            );
          },
          async disconnect() {
            await me.swarm?.destroy();
            me.swarm = undefined;
          },
          async restart() {
            await me.swarm?.destroy();
            me.swarm = undefined;
            await me.store.close();
            me.store = createHyperDriveStore(join(dir, "corestore"));
            await me.store.ready();
            return me.store;
          },
        };
      },
      async close() {
        for (const n of nodes) {
          await n.swarm?.destroy();
          await n.store.close();
        }
      },
    };
  }

  return {
    world() {
      const w = world();
      worlds.push(w);
      return w;
    },
    async destroy() {
      for (const w of worlds) await w.close();
      await testnet.destroy();
      for (const d of dirs) rmSync(d, { recursive: true, force: true });
    },
  };
}

/** Real PeerNetworks on one `hyperdht/testnet`. Each `world()` is its own set of nodes and topics. */
export async function realPeerWorlds(): Promise<{
  world(): PeerWorld;
  destroy(): Promise<void>;
}> {
  const testnet = await createTestnet(3);
  const worlds: PeerWorld[] = [];

  function world(): PeerWorld {
    const nodes: PeerNode[] = [];
    return {
      async node() {
        const identityKey = randomBytes(32).toString("hex");
        const events: PeerEvent[] = [];
        const build = () => {
          const network = createHyperPeerNetwork({
            bootstrap: testnet.bootstrap,
            replicate: () => {},
            log: () => {},
          });
          network.start(identityKey, (e: PeerEvent) => events.push(e));
          return network;
        };
        let network = build();
        const node: PeerNode = {
          get network() {
            return network;
          },
          identityKey,
          events,
          async restart() {
            await network.close();
            network = build();
            return network;
          },
        };
        nodes.push(node);
        return node;
      },
      topic: () => randomBytes(32).toString("hex"),
      async close() {
        for (const n of nodes) await n.network.close();
      },
    };
  }

  return {
    world() {
      const w = world();
      worlds.push(w);
      return w;
    },
    async destroy() {
      for (const w of worlds) await w.close();
      await testnet.destroy();
    },
  };
}
