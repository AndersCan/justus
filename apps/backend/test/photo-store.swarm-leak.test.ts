/**
 * Regression test for the swarm-topic join leak (issue #95).
 *
 * Every `joinTopic` call registers a swarm topic that must later be reclaimed.
 * Before the fix two things leaked:
 *   1. `joinTopic` only ever pushed handles into a never-shrinking array, so
 *      re-joining the same topic (e.g. a reader announcing its own-drive topic
 *      on every `join()`) accumulated a handle per call.
 *   2. `unmountRuntime` closed member drives but never left their swarm topics,
 *      and `close()` only tore down the swarm without releasing the per-topic
 *      handles it held.
 *
 * This test counts live joins and asserts they stay bounded by the number of
 * distinct topics (1 identity + 1 per joined folder) and reach 0 on `close()`.
 */
import { describe, it, expect } from "vite-plus/test";
import { mkdirSync } from "node:fs";
import { createPhotoStore } from "../src/photo-store.ts";
import { FakeDrive, FakeSwarm, makeFakeDeps } from "./fake-drive.ts";

/** Hyperswarm that counts its live topic joins. */
class CountingSwarm extends FakeSwarm {
  activeJoins = 0;
  join(topic: Buffer, opts?: { server?: boolean }) {
    this.activeJoins++;
    const base = super.join(topic, opts);
    return {
      flushed: base.flushed,
      destroy: () => {
        this.activeJoins = Math.max(0, this.activeJoins - 1);
      },
    };
  }
}

/** Stores share ONE drive registry (so a drive opened by key resolves to the
 * same `FakeDrive` across stores, modelling p2p replication) and each gets its
 * own `CountingSwarm`. */
function buildDevices(names: string[]) {
  const cache = new Map<string, FakeDrive>();
  const meta = names.map(() => ({ ownDrive: null as FakeDrive | null }));
  const makeDriveFor =
    (i: number) =>
    (_cs: unknown, key?: Buffer): FakeDrive => {
      const seed = key ? key.toString("hex") : `seed-${i}-${Math.floor(Math.random() * 1e9)}`;
      const drive = new FakeDrive(seed);
      const id = drive.key.toString("hex");
      let cached = cache.get(id);
      if (!cached) {
        cache.set(id, drive);
        cached = drive;
      }
      if (!key && meta[i].ownDrive === null) meta[i].ownDrive = cached;
      return cached;
    };
  const devices = names.map((name, i) => {
    const swarm = new CountingSwarm();
    const changes: Array<{ folderId: string }> = [];
    const deps = makeFakeDeps({
      deviceName: name,
      onChanged: (c) => changes.push({ folderId: c.folderId }),
      makeDrive: makeDriveFor(i),
      makeSwarm: () => swarm,
    });
    mkdirSync(deps.cacheDir, { recursive: true });
    const store = createPhotoStore(deps);
    return { store, changes, deps, ownDrive: () => meta[i].ownDrive!, swarm };
  });
  return { devices, cache };
}

describe("#95 swarm joins must not leak", () => {
  it("joins each topic once and releases every join on close", async () => {
    const { devices } = buildDevices(["Creator1", "Creator2", "Creator3", "Reader"]);
    const [c1, c2, c3, reader] = devices;
    await c1.store.ready();
    await c2.store.ready();
    await c3.store.ready();
    await reader.store.ready();

    // ownDrive is joined once at setup.
    expect(reader.swarm.activeJoins).toBe(1);

    const f1 = (await c1.store.createFolder("F1"))[1]!.folder.shareKey;
    const f2 = (await c2.store.createFolder("F2"))[1]!.folder.shareKey;
    const f3 = (await c3.store.createFolder("F3"))[1]!.folder.shareKey;

    // Joining a folder opens that folder's drive (1 join). The reader also
    // announces its own-drive topic — idempotent, so it must NOT add a join.
    const r1 = await reader.store.join(f1);
    expect(r1[0]).toBeNull();
    expect(reader.swarm.activeJoins).toBe(2); // ownDrive + F1

    const r2 = await reader.store.join(f2);
    expect(r2[0]).toBeNull();
    expect(reader.swarm.activeJoins).toBe(3); // + F2

    const r3 = await reader.store.join(f3);
    expect(r3[0]).toBeNull();
    expect(reader.swarm.activeJoins).toBe(4); // + F3

    // Bounded: 1 identity + 3 folder drives. Without the fix each `join`
    // re-announced ownDrive, so this would be 1 + 2*3 = 7 (and climbing).

    // Re-joining an already-held folder (#47) must not add a join.
    const r1again = await reader.store.join(f1);
    expect(r1again[0]).toBeNull();
    expect(reader.swarm.activeJoins).toBe(4);

    // close() must release every join, including the identity join.
    await reader.store.close();
    expect(reader.swarm.activeJoins).toBe(0);

    await c1.store.close();
    await c2.store.close();
    await c3.store.close();
  });
});
