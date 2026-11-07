/**
 * Bare twin of `../real-peers.ts`: the same real Corestore, Hyperdrive,
 * Hyperswarm and protomux greeting, but wired exactly as production wires them
 * in `src/main.core.ts` (bare-fs, bare-path, bare-crypto), inside the Bare
 * runtime. Nothing here may import `node:*` or vitest.
 *
 * The `hyperdht/testnet` runs inside this same Bare process. That keeps the
 * runner to one child process and exercises hyperdht under Bare too (it
 * supports it); the peers still talk over real UDP sockets on loopback.
 */
import fs from "bare-fs";
import path from "bare-path";
import crypto from "bare-crypto";
import Corestore from "corestore";
import Hyperdrive from "hyperdrive";
import Hyperswarm from "hyperswarm";
import createTestnet from "hyperdht/testnet";
import {
  createHyperDriveStore,
  type HyperDriveStore,
} from "../../src/adapters/hyper-drive-store.ts";
import { createPhotoStore, type PhotoStoreDeps } from "../../src/photo-store.ts";
import { createHyperPeerNetwork } from "../../src/adapters/hyper-peer-network.ts";
import type { PeerEvent } from "../../src/ports/peer-network.ts";
import type { DriveWorld } from "../contracts/drive-store.contract.ts";
import type { PeerNode, PeerWorld } from "../contracts/peer-network.contract.ts";
import type { WiredNode, WiredWorld } from "../contracts/wired.contract.ts";
import { eventually, type Net, type Peer, PhotoChanged } from "../p2p-scenarios.ts";
import { createP2pLog, type P2pEvent } from "../../src/p2p-log.ts";

/** Stand-in for the loopback server: the store only mounts routes on it. */
const stubServer = {
  mount() {},
  unmount: async () => {},
  origin: async () => "http://localhost:0",
  url: async (p: string) => `http://localhost:0${p}`,
  token: () => "",
  mountDir() {},
  onConnection() {},
  registerRoute() {},
  push: () => false,
  close() {},
} as unknown as PhotoStoreDeps["server"];

export async function bareNet(root: string): Promise<Net> {
  const testnet = await createTestnet(5);
  const live = new Set<Peer>();
  let n = 0;

  async function peer(
    name: string,
    storageDir?: string,
    opts: {
      peerProtocol?: number;
      legacy?: boolean;
      friends?: string[];
      offerReachMs?: number;
    } = {},
  ): Promise<Peer> {
    const dir = storageDir ?? path.join(root, `${name}-${n++}`);
    const cacheDir = path.join(dir, "cache");
    fs.mkdirSync(cacheDir, { recursive: true });
    const changes: PhotoChanged[] = [];
    const events: P2pEvent[] = [];
    const drives = createHyperDriveStore(path.join(dir, "corestore"));
    const store = createPhotoStore({
      storageDir: dir,
      cacheDir,
      server: stubServer,
      deviceName: name,
      onChanged: (c) => changes.push(c),
      seedOnEmpty: false,
      peerProtocol: opts.peerProtocol,
      isFriend: (identity: string) => opts.friends?.includes(identity) ?? false,
      offerReachMs: opts.offerReachMs,
      fs,
      path,
      crypto,
      drives,
      network: createHyperPeerNetwork({
        bootstrap: testnet.bootstrap as never,
        replicate: (conn) => drives.replicate(conn),
        log: createP2pLog((e: P2pEvent) => events.push(e)),
        ...(opts.legacy ? { openVersion: () => {} } : {}),
      }),
      driveOpenTimeoutMs: 10_000,
      log: (e: P2pEvent) => events.push(e),
    });
    await store.ready();
    let stopped = false;
    const p: Peer = {
      name,
      storageDir: dir,
      store,
      drives,
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
    },
  };
}

/**
 * Bare twin of `realDriveWorlds` in `../real-peers.ts`: real DriveStores on one
 * in-process `hyperdht/testnet`. Each `world()` is its own mesh.
 */
export async function bareWorld(root: string): Promise<{
  world(): DriveWorld;
  destroy(): Promise<void>;
}> {
  const testnet = await createTestnet(3);
  const worlds: DriveWorld[] = [];
  let dirs = 0;

  function world(): DriveWorld {
    const topic: Uint8Array = crypto.randomBytes(32);
    const nodes: Array<{ swarm?: any; store: HyperDriveStore }> = [];
    let connected = 0;

    return {
      async node() {
        const dir = path.join(root, `drive-${dirs++}`, "corestore");
        fs.mkdirSync(dir, { recursive: true });
        const me: { swarm?: any; store: HyperDriveStore } = {
          store: createHyperDriveStore(dir),
        };
        nodes.push(me);
        await me.store.ready();
        return {
          get store() {
            return me.store;
          },
          async connect() {
            const swarm = new Hyperswarm({ bootstrap: testnet.bootstrap as never });
            swarm.on("connection", (conn: any) => {
              me.store.replicate(conn);
              conn.on("error", () => {});
            });
            try {
              await swarm.join(topic, { server: true, client: true }).flushed();
            } catch (error) {
              await swarm.destroy();
              throw error;
            }
            me.swarm = swarm;
            const peers = connected++;
            await eventually(
              async () => swarm.connections.size,
              (n) => n >= peers,
              "mesh connected",
              10_000,
            );
          },
          async disconnect() {
            if (me.swarm) connected--;
            await me.swarm?.destroy();
            me.swarm = undefined;
          },
          async restart() {
            if (me.swarm) connected--;
            await me.swarm?.destroy();
            me.swarm = undefined;
            await me.store.close();
            me.store = createHyperDriveStore(dir);
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
    },
  };
}

/**
 * Bare twin of `realPeerWorlds` in `../real-peers.ts`: real PeerNetworks on one
 * in-process `hyperdht/testnet`. Each `world()` is its own set of nodes and topics.
 */
export async function barePeerWorlds(root: string): Promise<{
  world(): PeerWorld;
  destroy(): Promise<void>;
}> {
  const testnet = await createTestnet(3);
  const worlds: PeerWorld[] = [];
  let dirs = 0;

  function world(): PeerWorld {
    const nodes: Array<{ node: PeerNode; drives: HyperDriveStore }> = [];
    return {
      async node(opts) {
        const dir = path.join(root, `peer-${dirs++}`, "corestore");
        fs.mkdirSync(dir, { recursive: true });
        const drives = createHyperDriveStore(dir);
        await drives.ready();
        const identityKey = Buffer.from(crypto.randomBytes(32)).toString("hex");
        const events: PeerEvent[] = [];
        const build = () => {
          const network = createHyperPeerNetwork({
            bootstrap: testnet.bootstrap,
            replicate: (conn) => drives.replicate(conn),
            log: () => {},
            ...(opts?.legacy ? { openVersion: () => {} } : {}),
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
        nodes.push({ node, drives });
        return node;
      },
      topic: () => Buffer.from(crypto.randomBytes(32)).toString("hex"),
      async close() {
        for (const n of nodes) await n.node.network.close();
        for (const n of nodes) await n.drives.close();
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

/** Bare twin of `realWiredWorlds` in `../real-peers.ts`. */
export async function bareWiredWorlds(root: string): Promise<{
  world(): WiredWorld;
  destroy(): Promise<void>;
}> {
  const testnet = await createTestnet(3);
  const worlds: WiredWorld[] = [];
  let dirs = 0;

  function world(): WiredWorld {
    const nodes: WiredNode[] = [];
    return {
      async node() {
        const dir = path.join(root, `wired-${dirs++}`, "corestore");
        fs.mkdirSync(dir, { recursive: true });
        let drives = createHyperDriveStore(dir);
        await drives.ready();
        const identityKey = (await drives.openOwn()).key;
        const events: PeerEvent[] = [];
        const build = () => {
          const network = createHyperPeerNetwork({
            bootstrap: testnet.bootstrap as never,
            replicate: (conn) => drives.replicate(conn),
            log: () => {},
          });
          network.start(identityKey, (e: PeerEvent) => events.push(e));
          return network;
        };
        let network = build();
        const node: WiredNode = {
          get drives() {
            return drives;
          },
          get network() {
            return network;
          },
          identityKey,
          events,
          async restart() {
            await network.close();
            await drives.close();
            drives = createHyperDriveStore(dir);
            await drives.ready();
            network = build();
          },
        };
        nodes.push(node);
        return node;
      },
      topic: () => Buffer.from(crypto.randomBytes(32)).toString("hex"),
      async close() {
        for (const n of nodes) await n.network.close();
        for (const n of nodes) await n.drives.close();
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
