/**
 * Regression test for the add/list spool-name mismatch (issues #81/#83/#87).
 *
 * `add` and `list` must serve a photo from the SAME spool file. Before the fix,
 * `add` mounted `${selfKey.slice(0,12)}-${id}${ext}` while `list` derived the
 * base64 `spoolNameFor(driveKey, id, ext)` — so an added photo was written under
 * a name nothing else referenced: its add-URL never matched its list-URL and the
 * real spool file was orphaned.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPhotoStore } from "../src/photo-store.ts";
import { FakeLoopbackServer, makeFakeDeps } from "./fake-drive.ts";

describe("#81/#83/#87 add and list must serve one photo from one spool name", () => {
  it("matches the add-URL to the list-URL and mounts it once", async () => {
    const server = new FakeLoopbackServer();
    const dir = mkdtempSync(join(tmpdir(), "justus-spool-"));
    const cacheDir = join(dir, "cache");
    mkdirSync(cacheDir, { recursive: true });
    const store = createPhotoStore(
      makeFakeDeps({ storageDir: dir, cacheDir, server, seedOnEmpty: false }),
    );
    await store.ready();

    const created = await store.createFolder("Holidays");
    expect(created[0]).toBeNull();
    const folderId = created[1]!.folder.id;
    await store.setActive(folderId);

    const added = await store.addBytes("sunset.jpg", new Uint8Array([1, 2, 3, 4, 5]));
    expect(added[0]).toBeNull();
    const addedPhoto = added[1];

    const listed = await store.list();
    const listedPhoto = listed.find((p) => p.id === addedPhoto.id);
    expect(listedPhoto).toBeDefined();

    // `add` and `list` must agree on the spool route — they did not before the
    // fix, so the added photo's add-URL never matched its list-URL.
    const addRoute = new URL(addedPhoto.url).pathname;
    const listRoute = new URL(listedPhoto!.url).pathname;
    expect(listRoute).toBe(addRoute);

    // Exactly one mount carries that route — no duplicate/orphaned spool file.
    const mounted = [...server.routesForTest().keys()].filter((r) => r === addRoute);
    expect(mounted.length).toBe(1);

    await store.close();
  });
});
