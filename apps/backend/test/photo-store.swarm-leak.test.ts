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
 * distinct topics (identity + 2 per joined folder: its drive and this
 * device's own drive in it, #195) and reach 0 on `close()`.
 */
import createTestnet from "hyperdht/testnet";
import { afterAll, beforeAll, describe, it, expect } from "vite-plus/test";
import { mkdirSync } from "node:fs";
import { createHyperPeerNetwork } from "../src/adapters/hyper-peer-network.ts";
import { createPhotoStore } from "../src/photo-store.ts";
import { createP2pLog } from "../src/p2p-log.ts";
import type { PeerNetwork } from "../src/ports/peer-network.ts";
import { createFakeHub } from "./fakes/fake-world.ts";
import { fakeStoreDeps } from "./fakes/fake-store-deps.ts";

type Debug = { joins: { extraJoins: number }[] };

/** Live topic joins of the real adapter: one per topic, plus each upgrade session. */
function activeJoins(network: PeerNetwork): number {
  const { joins } = (network as unknown as { debug(): Debug }).debug();
  return joins.length + joins.reduce((sum, j) => sum + j.extraJoins, 0);
}

/** All stores share ONE hub (so a drive opened by key resolves across stores,
 * modelling p2p replication). Only the reader uses the real adapter, on its
 * own testnet, so it meets no one; the creators keep the fake network. */
function buildDevices(names: string[], bootstrap: string[]) {
  const hub = createFakeHub();
  const devices = names.map((name) => {
    const isReader = name === "Reader";
    const network = isReader
      ? createHyperPeerNetwork({
          bootstrap,
          replicate: () => {},
          log: createP2pLog(() => {}),
        })
      : undefined;
    const deps = fakeStoreDeps({ hub, deviceName: name, ...(network ? { network } : {}) });
    mkdirSync(deps.cacheDir, { recursive: true });
    const store = createPhotoStore(deps);
    return { store, deps, network: deps.network };
  });
  return { devices };
}

describe("#95 swarm joins must not leak", () => {
  let testnet: Awaited<ReturnType<typeof createTestnet>>;
  beforeAll(async () => {
    testnet = await createTestnet(3);
  });
  afterAll(async () => {
    await testnet.destroy();
  });

  it("joins each topic once and releases every join on close", async () => {
    const { devices } = buildDevices(
      ["Creator1", "Creator2", "Creator3", "Reader"],
      testnet.bootstrap,
    );
    const [c1, c2, c3, reader] = devices;
    await c1.store.ready();
    await c2.store.ready();
    await c3.store.ready();
    await reader.store.ready();

    // ownDrive is joined once at setup; a fresh install has no albums.
    expect(activeJoins(reader.network)).toBe(1);

    const f1 = (await c1.store.createFolder("F1"))[1]!.folder.shareKey;
    const f2 = (await c2.store.createFolder("F2"))[1]!.folder.shareKey;
    const f3 = (await c3.store.createFolder("F3"))[1]!.folder.shareKey;

    // Joining a folder opens that folder's drive as a client and serves this
    // device's own drive in it (2 joins). The reader then serves its request
    // on the folder topic: that upgrades the client-only join to announcing,
    // which Hyperswarm takes as one more session (#200: deduping it away
    // silently dropped the announce).
    const r1 = await reader.store.join(f1);
    expect(r1[0]).toBeNull();
    expect(activeJoins(reader.network)).toBe(4); // + F1 + own drive in F1 + F1 serve

    const r2 = await reader.store.join(f2);
    expect(r2[0]).toBeNull();
    expect(activeJoins(reader.network)).toBe(7); // + F2 trio

    const r3 = await reader.store.join(f3);
    expect(r3[0]).toBeNull();
    expect(activeJoins(reader.network)).toBe(10); // + F3 trio

    // Re-joining an already-held folder (#47) re-files the request but must
    // not add a join: the topic already serves.
    const r1again = await reader.store.join(f1);
    expect(r1again[0]).toBeNull();
    expect(activeJoins(reader.network)).toBe(10);

    // close() must release every join, including the identity join.
    await reader.store.close();
    expect(activeJoins(reader.network)).toBe(0);

    await c1.store.close();
    await c2.store.close();
    await c3.store.close();
  });
});
