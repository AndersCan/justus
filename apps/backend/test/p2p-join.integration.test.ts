/**
 * Two real devices on a local DHT: the join flow the fakes cannot prove.
 *
 * Real Corestore, Hyperdrive and Hyperswarm (on a `hyperdht/testnet`), the
 * real identity greeting, the real `createPhotoStore`. Pins the two bugs that
 * kept a desktop and a phone from ever seeing each other:
 *  - a joiner must notice the Admin's drive replicating in (Hyperdrive emits
 *    no `"update"`), so its album gets its name, photos and approval in-session;
 *  - an Admin must find the joiner's request, which lives on the joiner's
 *    identity drive, not under the connection's per-boot noise key.
 */
import { afterEach, describe, expect, it } from "vite-plus/test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import createTestnet from "hyperdht/testnet";
import { createPhotoStore, type PhotoStore } from "../src/photo-store.ts";
import { createHyperPeerNetwork } from "../src/adapters/hyper-peer-network.ts";
import { createHyperDriveStore } from "../src/adapters/hyper-drive-store.ts";
import { fakeStoreDeps } from "./fakes/fake-store-deps.ts";
import { makeTmpDir } from "./tmp-dirs.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function device(name: string, bootstrap: string[]) {
  const changes: string[] = [];
  const storageDir = makeTmpDir("justus-real-");
  const drives = createHyperDriveStore(join(storageDir, "corestore"));
  const deps = fakeStoreDeps({
    storageDir,
    cacheDir: join(storageDir, "cache"),
    deviceName: name,
    onChanged: (c) => changes.push(c.cause),
    drives,
    network: createHyperPeerNetwork({ bootstrap, replicate: (conn) => drives.replicate(conn) }),
    driveOpenTimeoutMs: 10_000,
  });
  mkdirSync(deps.cacheDir, { recursive: true });
  const store = createPhotoStore(deps);
  cleanups.push(async () => {
    await store.close();
    rmSync(deps.storageDir, { recursive: true, force: true });
  });
  return { store, changes };
}

async function eventually<T>(
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
    await new Promise((r) => setTimeout(r, 200));
  }
}

const albumIn = async (store: PhotoStore, shareKey: string) =>
  (await store.folders()).folders.find((f) => f.shareKey === shareKey);

describe("p2p join over a real swarm", () => {
  it("joiner sees the album, Admin sees the request, approval lands in-session", async () => {
    const testnet = await createTestnet(5);
    cleanups.push(() => testnet.destroy());

    const admin = device("Phone", testnet.bootstrap);
    const joiner = device("Desktop", testnet.bootstrap);
    await admin.store.ready();
    await joiner.store.ready();

    const created = await admin.store.createFolder("Test 1");
    expect(created[0]).toBeNull();
    const { id: folderId, shareKey } = created[1]!.folder;
    await admin.store.setActive(folderId);
    expect((await admin.store.addBytes("a.jpg", new Uint8Array([211, 2, 3])))[0]).toBeNull();

    // Join with the invite's name; the Admin's drive has not replicated yet.
    expect((await joiner.store.join(shareKey, "From invite"))[0]).toBeNull();

    // The joiner notices the Admin's drive replicating in: name and photo.
    await eventually(
      () => albumIn(joiner.store, shareKey),
      (f) => f?.name === "Test 1",
      "the Admin's album name on the joiner",
    );
    const photos = await eventually(
      () => joiner.store.list(),
      (l) => l.length === 1,
      "the Admin's photo on the joiner",
    );
    expect(photos[0].name).toBe("a.jpg");
    expect(joiner.changes).toContain("add");

    // The Admin finds the request on the joiner's identity drive.
    const { requests } = await eventually(
      () => admin.store.requests(),
      (r) => r.requests.length === 1,
      "the join request on the Admin",
    );
    expect(requests[0].requesterName).toBe("Desktop");
    expect(admin.changes).toContain("request");

    // Approval replicates back and upgrades the joiner without a re-join.
    expect((await admin.store.respond(folderId, requests[0].requesterKey, true))[0]).toBeNull();
    await eventually(
      () => albumIn(joiner.store, shareKey),
      (f) => f?.role === "member" && !f.pending,
      "the joiner's upgrade to member",
    );
  }, 60_000);
});
