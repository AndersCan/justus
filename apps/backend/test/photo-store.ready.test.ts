/**
 * Regression test for issue #98: `ready()` memoized a *rejected* `setup()`
 * promise, so any transient setup failure (flaky corestore/swarm, interrupted
 * disk) permanently poisoned the store — every later `ready()`/`list()`/`add()`
 * re-threw the same stale error and the app could never recover without a
 * restart. The fix clears the memoized promise on rejection so `ready()` can
 * retry.
 */
import { describe, it, expect } from "vite-plus/test";
import { mkdirSync } from "node:fs";
import { FakeCorestore, makeFakeDeps } from "./fake-drive.ts";
import { createPhotoStore } from "../src/photo-store.ts";

/** Corestore whose first `ready()` fails once, then succeeds — models a
 * transient startup hiccup that resolves on retry. */
class FlakyCorestore extends FakeCorestore {
  attempts = 0;
  async ready(): Promise<void> {
    this.attempts += 1;
    if (this.attempts === 1) throw new Error("transient setup failure");
  }
}

describe("#98 ready() must recover after a transient setup failure", () => {
  it("lets a later ready() succeed and the store become usable", async () => {
    const cs = new FlakyCorestore();
    const deps = makeFakeDeps({ makeCorestore: () => cs });
    // addBytes stages uploads into cacheDir; mirror the production runtime.
    mkdirSync(deps.cacheDir, { recursive: true });
    const store = createPhotoStore(deps);

    // First ready() hits the transient failure.
    let firstErr: unknown = null;
    try {
      await store.ready();
    } catch (e) {
      firstErr = e;
    }
    expect(firstErr).not.toBeNull();

    // The failure was transient; a second ready() must re-run setup and resolve.
    await expect(store.ready()).resolves.toBeUndefined();

    // And the store is now fully usable (the poison is gone).
    const created = await store.createFolder("Recover");
    expect(created[0]).toBeNull();

    await store.close();
  });
});
