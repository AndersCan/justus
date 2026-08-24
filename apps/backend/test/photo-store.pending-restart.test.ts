/**
 * Regression test for issue #94: a folder this device requested to join (and
 * whose enrollment is still awaiting the creator's approval) carries
 * `pending: true` in persisted state, but `loadState` was dropping it on
 * restart — so the "awaiting approval" badge vanished after a reload.
 *
 * The fix restores `pending` from the persisted folder record; `setup()` then
 * threads it through `toSummary` (it never re-derives a non-creator folder as
 * pending unless the flag is present). This test reproduces the on-disk state a
 * `join()` of an un-enrolled folder writes, then re-opens it (a "restart") and
 * asserts the flag survives.
 */
import { describe, it, expect } from "vite-plus/test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPhotoStore } from "../src/photo-store.ts";
import { makeFakeDeps } from "./fake-drive.ts";

describe("#94 a pending (awaiting-approval) join must survive a restart", () => {
  it("restores the pending flag from persisted state", async () => {
    const storageDir = mkdtempSync(join(tmpdir(), "justus-94-"));
    const cacheDir = join(storageDir, "cache");
    mkdirSync(cacheDir, { recursive: true });

    // The justus.json a `join()` of an un-enrolled folder persists: one reader
    // folder carrying `pending: true`, plus the device identity.
    const state = {
      name: "Restarted",
      activeFolderId: null,
      folders: [
        {
          id: "f-pending-1",
          name: "Trip",
          role: "reader",
          pending: true,
          shareKey: "0123456789abcdef".repeat(4),
          driveKey: "",
          createdAt: 0,
        },
      ],
    };
    writeFileSync(join(storageDir, "justus.json"), JSON.stringify(state), "utf8");

    // Session 2: simulate a restart against the same storageDir.
    const store = createPhotoStore(makeFakeDeps({ storageDir, cacheDir, seedOnEmpty: false }));
    await store.ready();

    const after = await store.folders();
    expect(after.folders.length).toBe(1);
    const folder = after.folders[0];
    expect(folder.id).toBe("f-pending-1");
    expect(folder.role).toBe("reader");
    // The bug: loadState dropped `pending`, so this was false after restart.
    expect(folder.pending).toBe(true);

    await store.close();
  });
});
