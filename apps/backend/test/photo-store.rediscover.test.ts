import { afterEach, describe, expect, it } from "vite-plus/test";
import { createPhotoStore } from "../src/photo-store.ts";
import type { P2pEvent } from "../src/p2p-log.ts";
import { makeFakeDeps } from "./fake-drive.ts";

describe("PhotoStore server-mode joins retry the peer lookup", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
  });

  it("re-runs the lookup for a created album while it has no peer", async () => {
    const events: P2pEvent[] = [];
    const base = makeFakeDeps({ log: (e: P2pEvent) => events.push(e) });
    const store = createPhotoStore({
      ...base,
      makeDrive: (cs: unknown, key?: Buffer) => {
        const drive = base.makeDrive(cs, key) as { core: { peers?: unknown[] } };
        drive.core.peers = [];
        return drive;
      },
    } as typeof base);
    close = () => store.close();
    await store.ready();
    const created = await store.createFolder("Trip");
    expect(created[0]).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(events.some((e) => e.event === "rediscover.attempt")).toBe(true);
  });
});
