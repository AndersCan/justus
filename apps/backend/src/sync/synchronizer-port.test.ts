import { createFakeSynchronizer, type PeerReport } from "./synchronizer-port.js";
import { describe, it, expect } from "vite-plus/test";

const KEY = "aa".repeat(32);

describe("FakeSynchronizer read-path parity", () => {
  it("returns the written bytes when read after put", async () => {
    const sync = createFakeSynchronizer({ now: () => 1000 });
    await sync.put(KEY, { path: "/photos/a.jpg", data: Buffer.from("hello") });
    const handle = await sync.open(KEY);
    expect(await handle.read("/photos/a.jpg")).toEqual(Buffer.from("hello"));
  });

  it("returns the half-open slice for a ranged read", async () => {
    const sync = createFakeSynchronizer({ now: () => 1000 });
    await sync.put(KEY, { path: "blob.bin", data: Buffer.from("0123456789") });
    const handle = await sync.open(KEY);
    expect(await handle.readRange("blob.bin", { start: 2, end: 5 })).toEqual(Buffer.from("234"));
    expect(await handle.readRange("blob.bin", { start: 0, end: 10 })).toEqual(
      Buffer.from("0123456789"),
    );
  });

  it("rejects a ranged read that falls outside the object", async () => {
    const sync = createFakeSynchronizer({ now: () => 1000 });
    await sync.put(KEY, { path: "blob.bin", data: Buffer.from("0123") });
    const handle = await sync.open(KEY);
    await expect(handle.readRange("blob.bin", { start: 0, end: 99 })).rejects.toThrow();
    await expect(handle.readRange("blob.bin", { start: 5, end: 2 })).rejects.toThrow();
  });

  it("returns sorted metadata for entries under a prefix", async () => {
    const sync = createFakeSynchronizer({ now: () => 1000 });
    await sync.put(KEY, { path: "/photos/b.jpg", data: Buffer.from("bb"), mtime: 20 });
    await sync.put(KEY, { path: "/photos/a.jpg", data: Buffer.from("a"), mtime: 10 });
    await sync.put(KEY, { path: "/meta.json", data: Buffer.from("{}"), mtime: 5 });
    const handle = await sync.open(KEY);
    const photos = await handle.list("/photos");
    expect(photos.map((e) => e.name)).toEqual(["photos/a.jpg", "photos/b.jpg"]);
    expect(photos[0]).toMatchObject({ size: 1, mtime: 10 });
  });

  it("reports size and mtime on stat and rejects a missing object", async () => {
    const sync = createFakeSynchronizer({ now: () => 1000 });
    await sync.put(KEY, { path: "/x", data: Buffer.from("abcd"), mtime: 42 });
    const handle = await sync.open(KEY);
    expect(await handle.stat("/x")).toMatchObject({ name: "x", size: 4, mtime: 42 });
    await expect(handle.stat("/nope")).rejects.toThrow();
    await expect(handle.read("/nope")).rejects.toThrow();
  });

  it("returns the same handle on repeated open and reclaims it on close", async () => {
    const sync = createFakeSynchronizer({ now: () => 1 });
    const first = await sync.open(KEY);
    const second = await sync.open(KEY);
    expect(first).toBe(second);
    await sync.close(KEY);
    await sync.put(KEY, { path: "/after", data: Buffer.from("z") });
    const third = await sync.open(KEY);
    expect(third).not.toBe(first);
    expect(await third.read("/after")).toEqual(Buffer.from("z"));
  });

  it("returns no peers for the in-memory fake", async () => {
    const sync = createFakeSynchronizer({ now: () => 1 });
    const handle = await sync.open(KEY);
    expect(handle.peers()).toEqual([]);
    // The real seam populates per-topic reports; the shape it must satisfy:
    const report: PeerReport = { key: KEY, topic: "topic-hex" };
    expect(report.topic).toBe("topic-hex");
  });
});
