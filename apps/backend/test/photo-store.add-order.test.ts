import { describe, it, expect, vi, afterEach } from "vite-plus/test";
import { mkdirSync } from "node:fs";
import { createPhotoStore } from "../src/photo-store.ts";
import { createFakeHub } from "./fakes/fake-world.ts";
import { fakeStoreDeps } from "./fakes/fake-store-deps.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("photos added in a run get strictly increasing stamps", () => {
  it("never repeats a stamp, even when the clock stands still or steps back", async () => {
    const deps = fakeStoreDeps({ hub: createFakeHub(), deviceName: "X" });
    mkdirSync(deps.cacheDir, { recursive: true });
    const store = createPhotoStore(deps);
    await store.ready();
    await store.createFolder("Mine");

    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    for (const n of [1, 2, 3]) {
      const [e] = await store.addBytes(`${n}.jpg`, new Uint8Array([n, 9, 9, 9]));
      expect(e).toBeNull();
    }
    now.mockReturnValue(900);
    const [e] = await store.addBytes("4.jpg", new Uint8Array([4, 9, 9, 9]));
    expect(e).toBeNull();

    const listed = await store.list();
    expect(listed.map((p) => p.addedAt)).toEqual([1003, 1002, 1001, 1000]);
    await store.close();
  });
});
