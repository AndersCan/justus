import { afterEach, describe, expect, it } from "vite-plus/test";
import { createPhotoStore } from "../src/photo-store.ts";
import type { P2pEvent } from "../src/p2p-log.ts";
import { makeFakeDeps } from "./fake-drive.ts";

describe("PhotoStore.debugState", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
  });

  it("returns a JSON-serialisable snapshot with the documented shape", async () => {
    const events: P2pEvent[] = [];
    const store = createPhotoStore(makeFakeDeps({ log: (e: P2pEvent) => events.push(e) }));
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
