/**
 * Regression tests for issues #93/#97: `add(path)` used to read any filesystem
 * path with no containment check, so a caller could name e.g. /etc/passwd and
 * have its contents mounted on the loopback server (disclosure to the web
 * client) and replicated to peers. Import paths must resolve inside an allowed
 * root (`cacheDir`, where the native picker copies selections) and must not
 * escape it via `..` segments or symlinks.
 */
import { describe, it, expect } from "vite-plus/test";
import { mkdirSync, writeFileSync, symlinkSync, existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPhotoStore, PhotoError } from "../src/photo-store.ts";
import { FakeLoopbackServer, makeFakeDeps } from "./fake-drive.ts";

function buildStore() {
  const deps = makeFakeDeps({ server: new FakeLoopbackServer() });
  mkdirSync(deps.cacheDir, { recursive: true });
  const store = createPhotoStore(deps);
  return { store, deps };
}

async function activeCreator(store: ReturnType<typeof createPhotoStore>) {
  await store.ready();
  const created = await store.createFolder("Pics");
  expect(created[0]).toBeNull();
  const folderId = (created[1] as { folder: { id: string } }).folder.id;
  await store.setActive(folderId);
  return folderId;
}

describe("#93/#97 add(path) must contain imports to allowed roots", () => {
  it("accepts a file inside cacheDir (the native picker's root)", async () => {
    const { store, deps } = buildStore();
    await activeCreator(store);
    const legit = join(deps.cacheDir, "photo.jpg");
    writeFileSync(legit, new Uint8Array([1, 2, 3, 4]));
    const res = await store.add(legit);
    expect(res[0]).toBeNull();
    await store.close();
  });

  it("rejects an absolute path outside the allowed root", async () => {
    const { store } = buildStore();
    await activeCreator(store);
    const res = await store.add("/etc/passwd");
    expect(res[0]?.code).toBe(PhotoError.FORBIDDEN);
    await store.close();
  });

  it("rejects `..` traversal out of the allowed root", async () => {
    const { store, deps } = buildStore();
    await activeCreator(store);
    // Plant a real file one level ABOVE cacheDir, then escape via `..`.
    const secret = join(deps.cacheDir, "..", "secret.txt");
    writeFileSync(secret, new Uint8Array([9, 9, 9]));
    const escaped = join(deps.cacheDir, "..", "secret.txt");
    const res = await store.add(escaped);
    expect(res[0]?.code).toBe(PhotoError.FORBIDDEN);
    await store.close();
  });

  it("rejects a symlink that points outside the allowed root", async () => {
    const { store, deps } = buildStore();
    await activeCreator(store);
    const link = join(deps.cacheDir, "escape");
    // Symlink inside the root but pointing at /etc — realpathSync must resolve
    // it to the target and reject before any bytes are read.
    symlinkSync("/etc", link);
    expect(existsSync(link)).toBe(true);
    const res = await store.add(join(link, "passwd"));
    expect(res[0]?.code).toBe(PhotoError.FORBIDDEN);
    await store.close();
  });

  it("accepts an import root reached through a symlinked ancestor (issue #129)", async () => {
    // macOS layout: /tmp -> /private/tmp, /var -> /private/var. The previous
    // walk started at `/` and flagged the symlinked ancestor, refusing legit
    // imports. Simulate it: a symlink (symAncestor -> realRoot) whose child is
    // the configured import root.
    const realRoot = mkdtempSync(join(tmpdir(), "justus-real-"));
    const symAncestor = join(
      tmpdir(),
      `justus-sym-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    symlinkSync(realRoot, symAncestor);
    const importRoot = join(symAncestor, "imports");
    mkdirSync(importRoot, { recursive: true });
    const deps = makeFakeDeps({
      server: new FakeLoopbackServer(),
      cacheDir: importRoot,
      importRoots: [importRoot],
    });
    const store = createPhotoStore(deps);
    await activeCreator(store);
    const legit = join(importRoot, "photo.jpg");
    writeFileSync(legit, new Uint8Array([1, 2, 3, 4]));
    const res = await store.add(legit);
    expect(res[0]).toBeNull();
    await store.close();
  });
});
