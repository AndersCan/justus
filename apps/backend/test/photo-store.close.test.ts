/**
 * Regression test for issue #101: `close()` tore down update watchers and the
 * swarm/corestore but never unmounted the loopback routes or removed the
 * per-folder spool directories — so a shutdown leaked mounts and stale cache.
 *
 * The fix routes each runtime through `unmountRuntime` (which already unmounts
 * routes and `rm -rf`s the spool dir). This test asserts that after `close()`
 * no loopback routes remain mounted and the spool dir is gone.
 */
import { describe, it, expect } from "vite-plus/test";
import { mkdtempSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPhotoStore } from "../src/photo-store.ts";
import { FakeLoopbackServer, makeFakeDeps } from "./fake-drive.ts";

describe("#101 close() must unmount routes and remove spool dirs", () => {
  it("leaves no loopback mounts or spool dirs after shutdown", async () => {
    const storageDir = mkdtempSync(join(tmpdir(), "justus-101-"));
    const cacheDir = join(storageDir, "cache");
    mkdirSync(cacheDir, { recursive: true });
    const server = new FakeLoopbackServer();

    const store = createPhotoStore(
      makeFakeDeps({ storageDir, cacheDir, server, seedOnEmpty: false }),
    );
    await store.ready();

    const created = await store.createFolder("Holidays");
    expect(created[0]).toBeNull();
    const folderId = created[1]!.folder.id;

    // Add a photo and pull the gallery so a loopback route is mounted and the
    // spool dir is populated.
    const add = await store.addBytes("beach.jpg", new Uint8Array([1, 2, 3, 4]));
    expect(add[0]).toBeNull();
    await store.list();

    // Sanity: something is actually mounted + spooled before we shut down.
    expect(server.routesForTest().size).toBeGreaterThan(0);
    const spoolDir = join(cacheDir, "photos", folderId);
    expect(existsSync(spoolDir)).toBe(true);

    await store.close();

    // The bug: mounts and spool dirs survived close().
    expect(server.routesForTest().size).toBe(0);
    expect(existsSync(spoolDir)).toBe(false);
  });
});
