/**
 * An album shares a display copy and a thumbnail the adding device made; the
 * original never leaves that device. Members fetch each copy only when it is
 * shown: listing an album downloads nothing.
 */
import { describe, it, expect } from "vite-plus/test";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createPhotoStore, PhotoError } from "../src/photo-store.ts";
import { FakeLoopbackServer, fakeStoreDeps } from "./fakes/fake-store-deps.ts";

function buildStore() {
  const server = new FakeLoopbackServer();
  const deps = fakeStoreDeps({ server });
  mkdirSync(deps.cacheDir, { recursive: true });
  const store = createPhotoStore(deps);
  return { store, deps, server };
}

async function activeCreator(store: ReturnType<typeof createPhotoStore>) {
  await store.ready();
  const created = await store.createFolder("Trip");
  expect(created[0]).toBeNull();
  const folderId = (created[1] as { folder: { id: string } }).folder.id;
  await store.setActive(folderId);
  return folderId;
}

/** Stage files the way a native host does: original + its two copies. */
function stage(dir: string, tag: string, original = [1, 2, 3, tag.length]) {
  const files = {
    original: join(dir, `${tag}-original.heic`),
    display: join(dir, `${tag}-display.jpg`),
    thumb: join(dir, `${tag}-thumb.jpg`),
  };
  writeFileSync(files.original, new Uint8Array(original));
  writeFileSync(files.display, new Uint8Array([10, 11, 12, 13, 14, 15]));
  writeFileSync(files.thumb, new Uint8Array([20, 21]));
  return files;
}

describe("shared copies", () => {
  it("stores the display copy and thumbnail, never the original", async () => {
    const { store, deps, server } = buildStore();
    await activeCreator(store);
    const f = stage(deps.cacheDir, "a");
    const [error, photo] = await store.add(f.display, "IMG_0001.HEIC", undefined, {
      thumb: f.thumb,
      original: f.original,
      takenAt: "2026-07-01T12:30:00+02:00",
    });
    expect(error).toBeNull();
    expect(photo!.name).toBe("IMG_0001.HEIC");
    expect(photo!.mime).toBe("image/jpeg");
    expect(photo!.size).toBe(6);
    expect(photo!.takenAt).toBe("2026-07-01T12:30:00+02:00");
    expect(photo!.thumbUrl).toBeDefined();

    const display = await server.getForTest(new URL(photo!.url).pathname);
    expect([...display.body]).toEqual([10, 11, 12, 13, 14, 15]);
    expect(display.headers["Content-Type"]).toBe("image/jpeg");
    const thumb = await server.getForTest(new URL(photo!.thumbUrl!).pathname);
    expect([...thumb.body]).toEqual([20, 21]);

    // The host's staging files are spent once the album holds the photo.
    expect(existsSync(f.original) || existsSync(f.display) || existsSync(f.thumb)).toBe(false);
    await store.close();
  });

  it("lists the thumbnail for every photo", async () => {
    const { store, deps } = buildStore();
    await activeCreator(store);
    const f = stage(deps.cacheDir, "b");
    const [, added] = await store.add(f.display, "b.jpg", undefined, {
      thumb: f.thumb,
      original: f.original,
    });
    const [listed] = await store.list();
    expect(listed!.thumbUrl).toBe(added!.thumbUrl);
    expect(listed!.url).toBe(added!.url);
    await store.close();
  });

  it("dedupes on the original, though each encode of it differs", async () => {
    const { store, deps } = buildStore();
    await activeCreator(store);
    const first = stage(deps.cacheDir, "c", [7, 7, 7]);
    const [, a] = await store.add(first.display, "c.heic", undefined, {
      thumb: first.thumb,
      original: first.original,
    });
    const again = stage(deps.cacheDir, "d", [7, 7, 7]);
    writeFileSync(again.display, new Uint8Array([99]));
    const [, b] = await store.add(again.display, "c.heic", undefined, {
      thumb: again.thumb,
      original: again.original,
    });
    expect(b!.id).toBe(a!.id);
    expect(await store.list()).toHaveLength(1);
    await store.close();
  });

  it("takes the original's hash from a Web layer that kept the original", async () => {
    const { store, deps } = buildStore();
    await activeCreator(store);
    const sha256 = "ab".repeat(32);
    const one = stage(deps.cacheDir, "e");
    const [, a] = await store.add(one.display, "e.jpg", undefined, { thumb: one.thumb, sha256 });
    expect(a!.sha256).toBeUndefined(); // only listed photos surface it
    const two = stage(deps.cacheDir, "f");
    writeFileSync(two.display, new Uint8Array([42]));
    const [, b] = await store.add(two.display, "e.jpg", undefined, { thumb: two.thumb, sha256 });
    expect(b!.id).toBe(a!.id);
    await store.close();
  });

  it("refuses a copy in a format not every member can show", async () => {
    const { store, deps } = buildStore();
    await activeCreator(store);
    const display = join(deps.cacheDir, "x.heic");
    const thumb = join(deps.cacheDir, "x-thumb.jpg");
    writeFileSync(display, new Uint8Array([1]));
    writeFileSync(thumb, new Uint8Array([2]));
    const [error] = await store.add(display, "x.heic", undefined, { thumb });
    expect(error?.code).toBe(PhotoError.UNSUPPORTED_FORMAT);
    // A failed add keeps the staged files, so Retry can use them.
    expect(existsSync(display)).toBe(true);
    await store.close();
  });

  it("contains the thumbnail and original paths like the display copy", async () => {
    const { store, deps } = buildStore();
    await activeCreator(store);
    const f = stage(deps.cacheDir, "g");
    const [error] = await store.add(f.display, "g.jpg", undefined, {
      thumb: f.thumb,
      original: "/etc/passwd",
    });
    expect(error?.code).toBe(PhotoError.FORBIDDEN);
    await store.close();
  });

  it("removes the thumbnail with the photo", async () => {
    const { store, deps, server } = buildStore();
    await activeCreator(store);
    const f = stage(deps.cacheDir, "h");
    const [, photo] = await store.add(f.display, "h.jpg", undefined, {
      thumb: f.thumb,
      original: f.original,
    });
    const [error] = await store.remove(photo!.id);
    expect(error).toBeNull();
    expect(await store.list()).toHaveLength(0);
    // The thumb's route is still registered, but its bytes are gone.
    const thumb = await server.getForTest(new URL(photo!.thumbUrl!).pathname);
    expect(thumb.status).not.toBe(200);
    await store.close();
  });
});

describe("loading on demand", () => {
  it("listing an album spools nothing; loading a photo spools only it", async () => {
    const { store, deps, server } = buildStore();
    const folderId = await activeCreator(store);
    await store.addBytes("one.jpg", new Uint8Array([1, 1]));
    await store.addBytes("two.jpg", new Uint8Array([2, 2]));
    const spoolDir = join(deps.cacheDir, "photos", folderId);

    const photos = await store.list();
    expect(photos).toHaveLength(2);
    await store.status();
    expect(existsSync(spoolDir)).toBe(false);

    const loaded = await server.getForTest(new URL(photos[0]!.url).pathname);
    expect(loaded.status).toBe(200);
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(spoolDir)).toHaveLength(1);
    await store.close();
  });
});
