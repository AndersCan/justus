import createTestnet from "hyperdht/testnet";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vite-plus/test";
import { createHyperPeerNetwork } from "../src/adapters/hyper-peer-network.ts";
import { createPhotoStore } from "../src/photo-store.ts";
import { createP2pLog } from "../src/p2p-log.ts";
import type { P2pEvent } from "../src/p2p-log.ts";
import { fakeStoreDeps } from "./fakes/fake-store-deps.ts";

describe("PhotoStore.debugState", () => {
  let testnet: Awaited<ReturnType<typeof createTestnet>>;
  beforeAll(async () => {
    testnet = await createTestnet(3);
  });
  afterAll(async () => {
    await testnet.destroy();
  });

  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
  });

  it("returns a JSON-serialisable snapshot with the documented shape", async () => {
    const events: P2pEvent[] = [];
    const sink = (e: P2pEvent) => events.push(e);
    const store = createPhotoStore(
      fakeStoreDeps({
        log: sink,
        network: createHyperPeerNetwork({
          bootstrap: testnet.bootstrap,
          replicate: () => {},
          log: createP2pLog(sink),
        }),
      }),
    );
    close = () => store.close();
    await store.ready();
    const created = await store.createFolder("Trip");
    expect(created[0]).toBeNull();

    const state = JSON.parse(JSON.stringify(store.debugState()));
    expect(state).toMatchObject({
      connections: [],
      peerIdentities: [],
      remoteDrives: [],
      rediscoverTimers: expect.any(Number),
    });
    expect(state.joins.length).toBeGreaterThan(0);
    expect(state.joins[0]).toMatchObject({
      topic: expect.any(String),
      served: expect.any(Boolean),
    });
    const folder = state.folders.find((f: { role: string }) => f.role === "creator");
    expect(folder).toMatchObject({
      role: "creator",
      pending: false,
      folderDrive: { key: expect.any(String) },
      members: [],
    });
    expect(events.some((e) => e.event === "topic.join")).toBe(true);
  });
});
