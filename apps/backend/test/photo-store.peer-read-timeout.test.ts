/**
 * Peer request reads are bounded so a vanished peer cannot hang `requests()`,
 * while every other record read keeps waiting for replication.
 */
import { describe, it, expect } from "vite-plus/test";
import { mkdirSync } from "node:fs";
import { createPhotoStore } from "../src/photo-store.ts";
import { FakeDrive, FakeSwarm, fakeConnection, makeFakeDeps } from "./fake-drive.ts";

describe("peer record read timeout", () => {
  it("requests() passes a timeout for the peer outbox read; a hung peer reads as no requests", async () => {
    const peer = "b".repeat(64);
    const seen: { path: string; timeout: number | undefined }[] = [];
    const cache = new Map<string, FakeDrive>();
    let swarm: FakeSwarm | null = null;
    const deps = makeFakeDeps({
      deviceName: "Creator",
      makeSwarm: () => {
        swarm = new FakeSwarm();
        return swarm;
      },
      makeDrive: (_cs: unknown, key?: Buffer): FakeDrive => {
        const seed = key ? key.toString("hex") : `seed-${cache.size}`;
        const drive = new FakeDrive(seed);
        const id = drive.key.toString("hex");
        const cached = cache.get(id);
        if (cached) return cached;
        cache.set(id, drive);
        if (id === peer) {
          // Behaves like a block only a departed peer had: never resolves
          // unless the caller bounded the read.
          const hang = (path: string, opts?: { timeout?: number }): Promise<never> => {
            seen.push({ path, timeout: opts?.timeout });
            return opts?.timeout === undefined
              ? new Promise<never>(() => {})
              : Promise.reject(new Error("timed out"));
          };
          Object.assign(drive, { get: hang, entry: hang });
        }
        return drive;
      },
    });
    mkdirSync(deps.cacheDir, { recursive: true });
    const store = createPhotoStore(deps);
    await store.ready();
    const created = await store.createFolder("Family");
    expect(created[0]).toBeNull();
    swarm!.emit("connection", fakeConnection(Buffer.from(peer, "hex")));

    const { requests } = await store.requests();
    expect(requests).toEqual([]);
    const reads = seen.filter((s) => s.path === "/requests.json");
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((s) => s.timeout === 5_000)).toBe(true);
    await store.close();
  });
});
