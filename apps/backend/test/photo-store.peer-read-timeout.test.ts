/**
 * Peer request reads are bounded so a vanished peer cannot hang `requests()`,
 * while every other record read keeps waiting for replication.
 */
import { describe, it, expect } from "vite-plus/test";
import { mkdirSync } from "node:fs";
import { createPhotoStore } from "../src/photo-store.ts";
import { createFakeHub } from "./fakes/fake-world.ts";
import { fakeStoreDeps, peerPhone } from "./fakes/fake-store-deps.ts";

describe("peer record read timeout", () => {
  it("requests() passes a timeout for the peer outbox read; a hung peer reads as no requests", async () => {
    const peer = "b".repeat(64);
    const seen: { path: string; timeout: number | undefined }[] = [];
    const hub = createFakeHub();
    const deps = fakeStoreDeps({ hub, deviceName: "Creator" });
    mkdirSync(deps.cacheDir, { recursive: true });
    const store = createPhotoStore(deps);
    await store.ready();

    // Opened on the store first, so it hands this same drive to `requests()`.
    // It behaves like a block only a departed peer had: never resolves unless
    // the caller bounded the read.
    const [openErr, drive] = await deps.drives.open(peer, { timeoutMs: 1_000 });
    if (openErr || !drive) throw openErr ?? new Error("peer drive did not open");
    drive.readSmall = (path: string, _maxBytes: number, opts?: { timeoutMs: number }) => {
      seen.push({ path, timeout: opts?.timeoutMs });
      return opts?.timeoutMs === undefined
        ? new Promise<never>(() => {})
        : Promise.reject(new Error("timed out"));
    };

    const created = await store.createFolder("Family");
    expect(created[0]).toBeNull();
    const identity = (store.debugState() as { identityDrive: string }).identityDrive;
    const phone = peerPhone(hub, { identityKey: peer });
    phone.meet(deps.drives.discoveryKeyOf(identity));
    for (let i = 0; i < 200 && !phone.events.some((e) => e.type === "identified"); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }

    const { requests } = await store.requests();
    expect(requests).toEqual([]);
    const reads = seen.filter((s) => s.path === "/requests.json");
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((s) => s.timeout === 5_000)).toBe(true);
    await store.close();
  });
});
