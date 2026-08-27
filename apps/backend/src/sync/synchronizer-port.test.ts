import { assertSynchronizerReadParity, PARITY_KEY } from "./parity.js";
import { createFakeSynchronizer, type PeerReport } from "./synchronizer-port.js";
import { describe, it, expect } from "vite-plus/test";

describe("FakeSynchronizer read-path parity", () => {
  it("validates the shared synchronizer read path", async () => {
    const sync = createFakeSynchronizer({ now: () => 1000 });
    await assertSynchronizerReadParity(sync);
  });
});

describe("FakeSynchronizer mirror semantics", () => {
  it("returns the same handle on repeated open and reclaims it on close", async () => {
    const sync = createFakeSynchronizer({ now: () => 1 });
    const first = await sync.open(PARITY_KEY);
    const second = await sync.open(PARITY_KEY);
    expect(first).toBe(second);
    await sync.close(PARITY_KEY);
    await sync.put(PARITY_KEY, { path: "/after", data: Buffer.from("z") });
    const third = await sync.open(PARITY_KEY);
    expect(third).not.toBe(first);
    expect(await third.read("/after")).toEqual(Buffer.from("z"));
  });

  it("returns the per-topic peers it was given", async () => {
    const peers: PeerReport[] = [
      { key: "bb".repeat(32), topic: "album-aa".repeat(8) },
      { key: "cc".repeat(32), topic: "album-bb".repeat(8) },
    ];
    const sync = createFakeSynchronizer({ now: () => 1, peers });
    const handle = await sync.open(PARITY_KEY);
    expect(handle.peers()).toEqual(peers);
    // A folder can tell which member drive a connection satisfies by topic.
    const forAlbum = handle.peers().filter((p) => p.topic.startsWith("album-aa"));
    expect(forAlbum).toHaveLength(1);
    expect(forAlbum[0].key).toBe("bb".repeat(32));
  });

  it("returns an empty peer list when no peers are injected", async () => {
    const sync = createFakeSynchronizer({ now: () => 1 });
    const handle = await sync.open(PARITY_KEY);
    expect(handle.peers()).toEqual([]);
  });
});
