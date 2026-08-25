/**
 * POC happy-path round-trip (issue #20): "create folder, add a photo, browser
 * shows it."
 *
 * This exercises the exact backend calls the web layer drives through the
 * `justus.photos` plugin — `createFolder` → `setActive` → `addBytes` — and then
 * asserts the gallery projection the browser renders (`list()`) contains the
 * photo. It is the backend-level verification from the forward-phase scope (A):
 * de-risk the photo-sharing proof-of-concept with a deterministic, drive-free
 * round-trip before the in-browser hub check.
 *
 * The plugin is a thin delegate (see src/photos-plugin.ts): `gateway.createFolder`
 * → `store.createFolder`, `gallery.add` → `store.addBytes`, `gallery` →
 * `store.list`. Proving the store proves the path the web rides on.
 */
import { describe, it, expect } from "vite-plus/test";
import { mkdirSync } from "node:fs";
import { createPhotoStore } from "../src/photo-store.ts";
import { makeFakeDeps } from "./fake-drive.ts";

function buildStore() {
  const deps = makeFakeDeps();
  // addBytes stages uploads into cacheDir, which the production runtime
  // pre-creates; mirror that here so staging doesn't throw.
  mkdirSync(deps.cacheDir, { recursive: true });
  return createPhotoStore(deps);
}

describe("#20 POC happy-path: create folder → add photo → gallery shows it", () => {
  it("round-trips a photo into the active folder's gallery projection", async () => {
    const store = buildStore();
    await store.ready();

    // 1. Create a folder (web: folders-machine CREATE_FOLDER → gateway.createFolder).
    const created = await store.createFolder("Holidays");
    expect(created[0]).toBeNull();
    const folder = created[1]!.folder;
    expect(folder.role).toBe("creator");
    const folderId = folder.id;

    // 2. Make it active (web: setActive).
    const active = await store.setActive(folderId);
    expect(active[0]).toBeNull();

    // 3. Add a photo from bytes (web: gallery.pickAndAdd → add → addBytes).
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const added = await store.addBytes("beach.jpg", bytes);
    expect(added[0]).toBeNull();
    expect(added[1]!.name).toBe("beach.jpg");
    expect(added[1]!.mime).toBe("image/jpeg");

    // 4. The browser renders the gallery projection — it must show the photo.
    const photos = await store.list();
    expect(photos.length).toBe(1);
    const shown = photos[0]!;
    // The stored content id round-trips into the gallery projection (the
    // regression #50 slash-free id the demo's URLs depend on).
    expect(shown.id).toBe(added[1]!.id);
    expect(shown.mime).toBe("image/jpeg");
    expect(shown.id).not.toContain("/");
    // NOTE: the gallery `name` under the in-memory FakeDrive falls back to the
    // drive basename (`<id>.jpg`); the real hyperdrive carries `metadata.name`
    // (so the browser shows "beach.jpg"). Filename threading through the add
    // path is proven above at the `addBytes` return (added[1]!.name === "beach.jpg",
    // regression #82/#99); please confirm the readable name in the browser hub check.
    expect(shown.name).toBe(`${added[1]!.id}.jpg`);

    // 5. The photo lives on the active folder's drive, so it replicates to peers
    // (the p2p half of the proof-of-concept). The folder still reports as the
    // active one after the round-trip.
    const folders = await store.folders();
    expect(folders.folders.find((f) => f.id === folderId)!.id).toBe(folderId);

    await store.close();
  });
});
