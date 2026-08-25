/**
 * Tests for the fake-drive harness substitutes (issue #24).
 *
 * These exercise the in-memory `FakeDrive` / `FakeSwarm` / `FakeLoopbackServer`
 * and the `makeFakeDeps` DI helper in isolation — no Bare runtime required, so
 * they run under plain Node vitest. They lock the contract the
 * `createPhotoStore` DI seam (photo-store.ts) will be injected with when the
 * six drive-dependent bug scenarios (#42/#43/#46/#47/#49/#52) are wired up.
 */
import { describe, expect, it } from "vite-plus/test";
import { FakeDrive, FakeLoopbackServer, FakeSwarm, makeFakeDeps } from "./fake-drive.ts";

describe("FakeDrive", () => {
  it("stores and lists entries in-memory", async () => {
    const drive = new FakeDrive("seed-a");
    expect(Buffer.isBuffer(drive.key)).toBe(true);
    expect(Buffer.isBuffer(drive.discoveryKey)).toBe(true);
    // Distinct seeds → distinct identities (needed for #42/#43/#47).
    expect(drive.key.equals(new FakeDrive("seed-a").key)).toBe(true);
    expect(drive.key.equals(new FakeDrive("seed-b").key)).toBe(false);

    await drive.put("/photos/a.jpg", Buffer.from("a"));
    await drive.put("/photos/b.jpg", Buffer.from("b"));
    expect((await drive.get("/photos/a.jpg"))?.toString()).toBe("a");
    expect(await drive.get("/missing")).toBeNull();

    const listed: Array<{ key: string; value: { metadata: Record<string, unknown> } }> = [];
    for await (const e of drive.list("/photos")) listed.push(e);
    expect(listed.map((e) => e.key).sort()).toEqual(["/photos/a.jpg", "/photos/b.jpg"]);
    // No metadata attached → empty metadata object (faithful to the real
    // hyperdrive `list()` contract `entry.value.metadata`).
    expect(listed.every((e) => Object.keys(e.value.metadata).length === 0)).toBe(true);

    await drive.del("/photos/a.jpg");
    expect(await drive.get("/photos/a.jpg")).toBeNull();
  });

  it("round-trips put metadata through list (v2 seam parity, issue #19)", async () => {
    const drive = new FakeDrive("seed-meta");
    await drive.put("/photos/a.jpg", Buffer.from("a"), {
      metadata: { name: "beach.jpg", mime: "image/jpeg", addedAt: 1000 },
    });
    const listed: Array<{ key: string; value: { metadata: Record<string, unknown> } }> = [];
    for await (const e of drive.list("/photos")) listed.push(e);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.key).toBe("/photos/a.jpg");
    expect(listed[0]!.value.metadata).toEqual({
      name: "beach.jpg",
      mime: "image/jpeg",
      addedAt: 1000,
    });

    // Metadata is dropped when the file is deleted, so a re-list is empty.
    await drive.del("/photos/a.jpg");
    const after: Array<{ key: string; value: { metadata: Record<string, unknown> } }> = [];
    for await (const e of drive.list("/photos")) after.push(e);
    expect(after).toHaveLength(0);
  });

  it("fires update handlers on put/del (used by #46 watcher tests)", () => {
    const drive = new FakeDrive("seed-c");
    const seen: string[] = [];
    drive.on("update", () => seen.push("update"));
    drive.emitUpdate();
    expect(seen).toEqual(["update"]);
    drive.removeListener("update", () => seen.push("x"));
    drive.emitUpdate();
    // Handler still registered until removed by the store's teardown.
    expect(seen).toEqual(["update", "update"]);
  });

  it("provides a no-op stream + close", async () => {
    const drive = new FakeDrive("seed-d");
    expect(drive.createReadStream("/x")).toBeDefined();
    await expect(drive.close()).resolves.toBeUndefined();
  });
});

describe("FakeSwarm", () => {
  it("joins topics and tracks no peers by default", () => {
    const swarm = new FakeSwarm();
    const handle = swarm.join(Buffer.from("topic"), { server: true });
    expect(typeof handle.flushed).toBe("function");
    expect(swarm.connections).toBeInstanceOf(Set);
    expect(swarm.connections.size).toBe(0);
    expect(() => swarm.destroy()).not.toThrow();
  });
});

describe("FakeLoopbackServer", () => {
  it("records mounts and reports an origin", async () => {
    const server = new FakeLoopbackServer();
    await server.mount("/photos/1/x", "/tmp/x");
    expect(server.routesForTest().get("/photos/1/x")).toBe("/tmp/x");
    await server.unmount("/photos/1/x");
    expect(server.routesForTest().has("/photos/1/x")).toBe(false);
    expect(await server.origin()).toBe("http://localhost:0");
  });
});

describe("makeFakeDeps", () => {
  it("produces a complete, in-memory PhotoStoreDeps", () => {
    const deps = makeFakeDeps();
    expect(typeof deps.storageDir).toBe("string");
    expect(typeof deps.cacheDir).toBe("string");
    expect(deps.server).toBeInstanceOf(FakeLoopbackServer);
    expect(typeof deps.makeCorestore).toBe("function");
    expect(typeof deps.makeSwarm).toBe("function");
    expect(typeof deps.makeDrive).toBe("function");
    // Stable corestore instance keeps drive identity consistent per store.
    expect(deps.makeCorestore!("dir")).toBe(deps.makeCorestore!("dir"));
  });
});
