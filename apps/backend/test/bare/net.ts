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
import { createPhotoStore, type PhotoStoreDeps } from "../../src/photo-store.ts";
import type { Net, Peer, PhotoChanged } from "../p2p-scenarios.ts";

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
  const testnet = await createTestnet(3);
  const live = new Set<Peer>();
  let n = 0;

  async function peer(name: string, storageDir?: string): Promise<Peer> {
    const dir = storageDir ?? path.join(root, `${name}-${n++}`);
    const cacheDir = path.join(dir, "cache");
    fs.mkdirSync(cacheDir, { recursive: true });
    const changes: PhotoChanged[] = [];
    const store = createPhotoStore({
      storageDir: dir,
      cacheDir,
      server: stubServer,
      deviceName: name,
      onChanged: (c) => changes.push(c),
      seedOnEmpty: false,
      fs,
      path,
      crypto,
      makeCorestore: (d) => new Corestore(d),
      makeDrive: (cs, key) => new Hyperdrive(cs as never, key),
      makeSwarm: () => new Hyperswarm({ bootstrap: testnet.bootstrap as never }),
      driveOpenTimeoutMs: 10_000,
    });
    await store.ready();
    let stopped = false;
    const p: Peer = {
      name,
      storageDir: dir,
      store,
      changes,
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
