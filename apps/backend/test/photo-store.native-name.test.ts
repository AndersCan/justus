/**
 * Regression test for issue #99: `store.add(path, name)` — the host-picked
 * file path — must preserve the original display name the native host passes
 * alongside the path (Android `DISPLAY_NAME`, iOS `itemProvider.suggestedName`),
 * instead of recording the host's generated temp staging name
 * (`media-<uuid>.<ext>`, `capture-<ts>.jpg`).
 *
 * Built on the in-memory substitutes from `./fake-drive` — no Bare runtime
 * required.
 */
import { describe, it, expect } from "vite-plus/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPhotoStore } from "../src/photo-store.ts";
import { makeFakeDeps } from "./fake-drive.ts";

function buildStore() {
  const deps = makeFakeDeps({ deviceName: "Namer" });
  mkdirSync(deps.cacheDir, { recursive: true });
  const store = createPhotoStore(deps);
  return { store, deps };
}

describe("#99 store.add(path, name) must preserve the host display name", () => {
  it("records the picker's display name, not the staging temp name", async () => {
    const { store, deps } = buildStore();
    await store.ready();

    const created = await store.createFolder("Holidays");
    expect(created[0]).toBeNull();
    const folderId = created[1]!.folder.id;
    await store.setActive(folderId);

    // The host stages the picked photo under a generated temp name (Android
    // media-<ts>.<ext>, iOS media-<uuid>.<ext>) and passes the real name.
    const stagedPath = join(deps.cacheDir, "media-1700000000000.jpg");
    writeFileSync(stagedPath, new Uint8Array([1, 2, 3, 4]));
    const add = await store.add(stagedPath, "IMG_2024_001.jpg");
    expect(add[0]).toBeNull();

    expect(add[1].name).toBe("IMG_2024_001.jpg");
    expect(add[1].name.startsWith("media-")).toBe(false);

    await store.close();
  });

  it("falls back to the basename when no name is supplied", async () => {
    const { store, deps } = buildStore();
    await store.ready();

    const created = await store.createFolder("Trip");
    expect(created[0]).toBeNull();
    const folderId = created[1]!.folder.id;
    await store.setActive(folderId);

    const stagedPath = join(deps.cacheDir, "capture-1700000000000.jpg");
    writeFileSync(stagedPath, new Uint8Array([9, 9, 9]));
    const add = await store.add(stagedPath);
    expect(add[0]).toBeNull();

    // No name: the stored photo keeps the temp file's basename (old behaviour).
    expect(add[1].name).toBe("capture-1700000000000.jpg");

    await store.close();
  });
});
