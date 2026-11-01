/**
 * Node harness for real-swarm tests: real Corestore, Hyperdrive, Hyperswarm (on
 * a `hyperdht/testnet`), the real protomux identity greeting, real node fs.
 * Only the loopback server is a stand-in. Use it for any behaviour that depends
 * on how the p2p libraries actually behave (#200): a fake would encode our
 * assumptions instead of checking them. The Bare twin is `test/bare/net.ts`.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Corestore from "corestore";
import Hyperdrive from "hyperdrive";
import Hyperswarm from "hyperswarm";
import createTestnet from "hyperdht/testnet";
import { createPhotoStore } from "../src/photo-store.ts";
import { makeFakeDeps } from "./fake-drive.ts";
import type { Net, Peer, PhotoChanged } from "./p2p-scenarios.ts";

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
  const testnet = await createTestnet(3);
  const dirs: string[] = [];
  const live = new Set<Peer>();

  async function peer(name: string, storageDir?: string): Promise<Peer> {
    const dir = storageDir ?? mkdtempSync(join(tmpdir(), `justus-real-${name}-`));
    if (!storageDir) dirs.push(dir);
    const changes: PhotoChanged[] = [];
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
