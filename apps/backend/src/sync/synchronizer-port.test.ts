import { assertSynchronizerParity, assertSynchronizerReadParity, PARITY_KEY } from "./parity.js";
import { createFakeSynchronizer, type PeerReport } from "./synchronizer-port.js";
import { describe, it, expect } from "vite-plus/test";

describe("FakeSynchronizer read-path parity", () => {
  it("validates the shared synchronizer read path", async () => {
    const sync = createFakeSynchronizer({ now: () => 1000 });
    await assertSynchronizerReadParity(sync);
  });
});

describe("FakeSynchronizer complete parity", () => {
  it("validates the full synchronizer read and write contract", async () => {
    const sync = createFakeSynchronizer({ now: () => 1000 });
    await assertSynchronizerParity(sync);
  });
});

describe("FakeSynchronizer store-flow", () => {
  it("mirrors a peer's photo set byte-for-byte through the port", async () => {
    const sync = createFakeSynchronizer({ now: () => 1000 });
    const remote = await sync.open(PARITY_KEY);

    // A peer publishes a folder of photos with metadata.
    const photos = [
      { name: "photos/001.jpg", bytes: Buffer.from("aaaa"), mtime: 10 },
      { name: "photos/002.jpg", bytes: Buffer.from("bbbb"), mtime: 20 },
      { name: "photos/003.jpg", bytes: Buffer.from("cccc"), mtime: 30 },
    ];
    await Promise.all(
      photos.map((photo) =>
        sync.put(PARITY_KEY, { path: "/" + photo.name, data: photo.bytes, mtime: photo.mtime }),
      ),
    );
    await sync.put(PARITY_KEY, { path: "/meta.json", data: Buffer.from('{"n":3}'), mtime: 40 });

    // A sparse client that already has 001 mirrors the rest: list, then read the gaps.
    const have = new Set(["photos/001.jpg"]);
    const listed = await remote.list("/photos");
    const names = listed.map((entry) => entry.name);
    names.sort();
    expect(names).toEqual(["photos/001.jpg", "photos/002.jpg", "photos/003.jpg"]);
    const missing = listed.filter((entry) => !have.has(entry.name));
    const missingNames = missing.map((entry) => entry.name);
    expect(missingNames).toEqual(["photos/002.jpg", "photos/003.jpg"]);

    const byName = new Map(photos.map((photo) => [photo.name, photo.bytes]));
    const bodies = await Promise.all(missing.map((entry) => remote.read("/" + entry.name)));
    for (const [index, entry] of missing.entries()) {
      expect(bodies[index]).toEqual(byName.get(entry.name));
    }

    // After the mirror, the client holds exactly the peer's set, byte-identical.
    const after = await remote.list("");
    const afterNames = after.map((entry) => entry.name);
    afterNames.sort();
    expect(afterNames).toEqual(["meta.json", "photos/001.jpg", "photos/002.jpg", "photos/003.jpg"]);
    expect(await remote.read("/meta.json")).toEqual(Buffer.from('{"n":3}'));
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
