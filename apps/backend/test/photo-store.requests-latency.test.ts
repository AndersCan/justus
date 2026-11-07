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
import {
  addFakeNode,
  createFakeDriveStore,
  createFakeHub,
  setFakeNodeConnected,
} from "./fakes/fake-world.ts";
import { fakeStoreDeps, peerPhone } from "./fakes/fake-store-deps.ts";

describe("#88 requests() must not multiply per-peer latency across unreachable peers", () => {
  it("reads peer request outboxes concurrently, not sequentially", async () => {
    const timeoutMs = 50;
    const peerCount = 5;

    // 4 peers are unreachable (their drives never become ready); 1 is a
    // connected phone whose own drive carries a pending join request.
    const unreachablePeers = Array.from({ length: peerCount - 1 }, (_, i) =>
      (i + 1).toString(16).repeat(16).padEnd(64, "0"),
    );
    const delays = new Map(unreachablePeers.map((p) => [p, Infinity]));
    const hub = createFakeHub({ readyDelayMs: (key) => delays.get(key) ?? 0 });

    const reachableNode = addFakeNode(hub);
    setFakeNodeConnected({ hub, node: reachableNode, connected: true });
    const reachableDrive = await createFakeDriveStore({ hub, node: reachableNode }).openOwn();
    const reachablePeer = reachableDrive.key;

    const deps = fakeStoreDeps({ hub, deviceName: "Creator", driveOpenTimeoutMs: timeoutMs });
    mkdirSync(deps.cacheDir, { recursive: true });
    const store = createPhotoStore(deps);

    await store.ready();

    // Create the creator folder whose peers we will simulate.
    const created = await store.createFolder("Family");
    expect(created[0]).toBeNull();
    const folderKey = (created[1] as { folder: { shareKey: string } }).folder.shareKey;
    // Pending join request the reachable peer has filed for the creator folder.
    await reachableDrive.put(
      "/requests.json",
      Buffer.from(
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
      ),
    );

    // Simulate N peers connecting. Each greets the creator with an identity drive.
    const identity = (store.debugState() as { identityDrive: string }).identityDrive;
    const topic = deps.drives.discoveryKeyOf(identity);
    const phones = [reachablePeer, ...unreachablePeers].map((p) =>
      peerPhone(hub, { identityKey: p }),
    );
    for (const phone of phones) phone.meet(topic);
    for (
      let i = 0;
      i < 200 && !phones.every((p) => p.events.some((e) => e.type === "identified"));
      i++
    ) {
      await new Promise((r) => setTimeout(r, 10));
    }

    const start = Date.now();
    const { requests } = await store.requests();
    const elapsed = Date.now() - start;

    // The store has one creator folder (the one we made). Within a folder the
    // peer opens are now concurrent, so:
    //   fixed   ≈ creatorFolders × timeoutMs              ≈ 1 × 50 = 50ms
    //   buggy   ≈ creatorFolders × peerCount × timeoutMs  ≈ 1 × 5 × 50 = 250ms
    // Assert well under the buggy floor to prove concurrency.
    expect(elapsed).toBeLessThan(timeoutMs * 4);

    // The reachable peer's pending request must still be collected.
    expect(requests.length).toBe(1);
    expect(requests[0].requesterKey).toBe(reachablePeer);

    await store.close();
  });
});
