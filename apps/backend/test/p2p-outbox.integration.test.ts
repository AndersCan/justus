/**
 * What a stranger who knows a Collaborator's identity key can read over a real
 * swarm. The identity drive is public to anyone holding its key, so the ask
 * that created the Collaborator's album drive must not name that drive there,
 * in any version of the file.
 */
import { afterEach, describe, expect, it } from "vite-plus/test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import createTestnet from "hyperdht/testnet";
import Corestore from "corestore";
import Hyperdrive from "hyperdrive";
import Hyperswarm from "hyperswarm";
import { createPhotoStore } from "../src/photo-store.ts";
import { createHyperPeerNetwork } from "../src/adapters/hyper-peer-network.ts";
import { createHyperDriveStore } from "../src/adapters/hyper-drive-store.ts";
import { openAnswers } from "../src/adapters/peer-answer.ts";
import { fakeStoreDeps } from "./fakes/fake-store-deps.ts";
import { makeTmpDir } from "./tmp-dirs.ts";
import { eventually } from "./p2p-scenarios.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function device(name: string, bootstrap: string[]) {
  const storageDir = makeTmpDir("justus-outbox-");
  const drives = createHyperDriveStore(join(storageDir, "corestore"));
  const deps = fakeStoreDeps({
    storageDir,
    cacheDir: join(storageDir, "cache"),
    deviceName: name,
    drives,
    network: createHyperPeerNetwork({
      bootstrap,
      replicate: (conn) => drives.replicate(conn),
      openAnswers,
    }),
    driveOpenTimeoutMs: 10_000,
  });
  mkdirSync(deps.cacheDir, { recursive: true });
  const store = createPhotoStore(deps);
  cleanups.push(async () => {
    await store.close();
    rmSync(deps.storageDir, { recursive: true, force: true });
  });
  const identity = () => (store.debugState() as { identityDrive: string }).identityDrive;
  return { store, identity };
}

describe("a Collaborator's outbox", () => {
  it("a stranger who knows a Collaborator's identity key cannot find their album drive", async () => {
    const net = await createTestnet(5);
    cleanups.push(() => net.destroy());
    const nils = device("Nils", net.bootstrap);
    const ben = device("Ben", net.bootstrap);
    await Promise.all([nils.store, ben.store].map((s) => s.ready()));

    const created = await nils.store.createFolder("Trip");
    const { id: folderId, shareKey, invite } = created[1]!.folder;
    expect(
      (await ben.store.ask({ code: invite!.code, owner: nils.identity(), albumName: "Trip" }))[0],
    ).toBeNull();
    const { requests } = await eventually(
      () => nils.store.requests(),
      (r) => r.requests.length === 1,
      "Ben's ask on Nils's phone",
      30_000,
    );
    const benDriveKey = requests[0]!.requesterKey;
    expect((await nils.store.respond(folderId, benDriveKey, true, "member"))[0]).toBeNull();
    const joined = await eventually(
      async () => (await ben.store.folders()).folders.find((f) => f.shareKey === shareKey),
      (f) => f?.role === "member",
      "Ben becomes a Collaborator",
      30_000,
    );
    expect(
      (await ben.store.addBytes("b.jpg", new Uint8Array([9, 9, 9]), joined!.id))[0],
    ).toBeNull();

    // Mallory never asked: a bare swarm holding only Ben's identity key.
    const dir = makeTmpDir("justus-mallory-");
    const store = new Corestore(dir);
    const swarm = new Hyperswarm({ bootstrap: net.bootstrap as never });
    cleanups.push(async () => {
      await swarm.destroy();
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    });
    swarm.on("connection", (conn: never) => store.replicate(conn));
    const outbox = new Hyperdrive(store, Buffer.from(ben.identity(), "hex"));
    await outbox.ready();
    swarm.join(outbox.discoveryKey, { server: false, client: true });
    await eventually(
      async () => {
        await outbox.update({ wait: true }).catch(() => false);
        return outbox.version;
      },
      (v) => v > 1,
      "Mallory replicated Ben's outbox",
      30_000,
    );

    const texts: string[] = [];
    for (let v = 1; v <= outbox.version; v++) {
      const at = outbox.checkout(v);
      const buf = await at.get("/requests.json").catch(() => null);
      if (buf) texts.push(Buffer.from(buf).toString());
    }
    expect(
      texts.some((t) => t.includes("invite:") && t.includes("sealedKey")),
      "an invite entry with sealedKey is visible, so the test is not vacuous",
    ).toBe(true);
    for (const t of texts)
      expect(t.includes(benDriveKey), "Ben's drive key in the outbox").toBe(false);
  }, 120_000);
});
