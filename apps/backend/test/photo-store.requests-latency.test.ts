/**
 * Regression test for issue #88: `requests()` must not multiply per-peer drive
 * open latency across unreachable peers. `readRequestsFromPeers` used to await
 * each peer's drive sequentially, so N unreachable peers cost N × the
 * open-drive timeout. After the fix the opens run concurrently, bounding total
 * latency to a single timeout regardless of N.
 */
import { describe, it, expect } from "vite-plus/test";
import { mkdirSync } from "node:fs";
import { createPhotoStore } from "../src/photo-store.ts";
import { FakeDrive, FakeSwarm, makeFakeDeps } from "./fake-drive.ts";

describe("#88 requests() must not multiply per-peer latency across unreachable peers", () => {
  it("reads peer request outboxes concurrently, not sequentially", async () => {
    const timeoutMs = 50;
    const peerCount = 5;

    // Map peer drive key -> ready() delay. 4 peers are unreachable (Infinity);
    // 1 is reachable and carries a pending join request for the folder.
    const peerDelay = new Map<string, number>();
    const reachablePeer = "a".repeat(64);
    const unreachablePeers = Array.from({ length: peerCount - 1 }, (_, i) =>
      (i + 1).toString(16).repeat(16).padEnd(64, "0"),
    );
    for (const p of unreachablePeers) peerDelay.set(p, Infinity);
    peerDelay.set(reachablePeer, 0);

    // Pending join request the reachable peer has filed for the creator folder.
    // Populated after the folder exists, then written into the reachable peer's
    // drive the moment it is opened (see makeDrive below).
    let pendingRequestFile: Buffer | null = null;

    const cache = new Map<string, FakeDrive>();
    let swarm: FakeSwarm | null = null;
    const deps = makeFakeDeps({
      deviceName: "Creator",
      driveOpenTimeoutMs: timeoutMs,
      makeSwarm: () => {
        swarm = new FakeSwarm();
        return swarm;
      },
      makeDrive: (_cs: unknown, key?: Buffer): FakeDrive => {
        const seed = key ? key.toString("hex") : `seed-${cache.size}`;
        const drive = new FakeDrive(seed, { readyDelayMs: peerDelay.get(seed) ?? 0 });
        const id = drive.key.toString("hex");
        let cached = cache.get(id);
        if (!cached) {
          cache.set(id, drive);
          cached = drive;
        }
        if (id === reachablePeer && pendingRequestFile) {
          void drive.put("/requests.json", pendingRequestFile);
        }
        return cached;
      },
    });
    mkdirSync(deps.cacheDir, { recursive: true });
    const store = createPhotoStore(deps);

    await store.ready();

    // Create the creator folder whose peers we will simulate.
    const created = await store.createFolder("Family");
    expect(created[0]).toBeNull();
    const folderKey = (created[1] as { folder: { shareKey: string } }).folder.shareKey;
    pendingRequestFile = Buffer.from(
      JSON.stringify({
        version: 1,
        requests: {
          r1: {
            requesterKey: reachablePeer,
            requesterName: "Reachable",
            shareKey: folderKey,
            folderName: "Family",
            requestedAt: 123,
          },
        },
      }),
    );

    // Simulate N peers connecting. The swarm "connection" handler records each
    // peer against every creator folder's social.peers set.
    const allPeers = [reachablePeer, ...unreachablePeers];
    for (const p of allPeers) {
      swarm!.emit("connection", {
        remotePublicKey: Buffer.from(p, "hex"),
        on() {},
      });
    }

    const start = Date.now();
    const { requests } = await store.requests();
    const elapsed = Date.now() - start;

    // The store has two creator folders (the auto-created "My Photos" plus the
    // one we made), and `requests()` reads each sequentially. Within a folder the
    // peer opens are now concurrent, so:
    //   fixed   ≈ creatorFolders × timeoutMs              ≈ 2 × 50 = 100ms
    //   buggy   ≈ creatorFolders × peerCount × timeoutMs  ≈ 2 × 5 × 50 = 500ms
    // Assert well under the buggy floor to prove concurrency.
    expect(elapsed).toBeLessThan(timeoutMs * 4);

    // The reachable peer's pending request must still be collected.
    expect(requests.length).toBe(1);
    expect(requests[0].requesterKey).toBe(reachablePeer);

    await store.close();
  });
});
