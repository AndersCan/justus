/**
 * Regression test for issue #82: `addBytes` (the browser multi-file picker /
 * in-band upload path) must preserve the original upload filename in the
 * stored `Photo.name`, instead of recording the transient `upload-<id>.<ext>`
 * staging filename.
 *
 * Built on the in-memory substitutes from `./fake-drive` (see
 * docs/design/fake-drive-test-harness-spec.md) — no Bare runtime required.
 */
import { describe, it, expect } from "vite-plus/test";
import { mkdirSync } from "node:fs";
import { createPhotoStore } from "../src/photo-store.ts";
import { makeFakeDeps } from "./fake-drive.ts";

function buildStore() {
  const deps = makeFakeDeps({ deviceName: "Filenamer" });
  // addBytes stages uploads into cacheDir, which the production runtime
  // pre-creates — mirror that here so staging doesn't throw.
  mkdirSync(deps.cacheDir, { recursive: true });
  const store = createPhotoStore(deps);
  return { store, deps };
}

describe("#82 addBytes must preserve the original upload filename", () => {
  it("records the real filename, not the upload-<id> staging name", async () => {
    const { store } = buildStore();
    await store.ready();

    const created = await store.createFolder("Holidays");
    expect(created[0]).toBeNull();
    const folderId = created[1]!.folder.id;
    await store.setActive(folderId);

    const photo = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const add = await store.addBytes("beach-sunset.jpg", photo);
    expect(add[0]).toBeNull();

    // Before the fix, `name` was the staging file's basename
    // (`upload-<id>.jpg`). After the fix it is the user's real filename.
    expect(add[1].name).toBe("beach-sunset.jpg");
    expect(add[1].name.startsWith("upload-")).toBe(false);

    // The stored name must survive a content-dedupe re-add (issue #43 path):
    // the re-add returns the same entry, whose name is still the original.
    const reAdd = await store.addBytes("beach-sunset.jpg", photo);
    expect(reAdd[0]).toBeNull();
    expect(reAdd[1].id).toBe(add[1].id);
    expect(reAdd[1].name).toBe("beach-sunset.jpg");

    await store.close();
  });

  it("falls back to a generated name when none is supplied", async () => {
    const { store } = buildStore();
    await store.ready();

    const created = await store.createFolder("Trip");
    expect(created[0]).toBeNull();
    const folderId = created[1]!.folder.id;
    await store.setActive(folderId);

    const photo = new Uint8Array([9, 9, 9]);
    // No name: the store should synthesize one rather than crash.
    const add = await store.addBytes("", photo);
    expect(add[0]).toBeNull();
    expect(typeof add[1].name).toBe("string");
    expect(add[1].name.length).toBeGreaterThan(0);
    expect(add[1].name.startsWith("upload-")).toBe(false);

    await store.close();
  });
});
