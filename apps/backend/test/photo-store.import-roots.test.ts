/**
 * Regression test for issue #157: after the #118 import-root containment landed,
 * `add(path)` rejected files the dev inbox / e2e inbox dropped in, because those
 * dirs are siblings of `cacheDir` (not nested in it) and were not declared as
 * allowed import roots. The fix wires the inbox into `importRoots` in
 * `main.core.ts`. These tests prove the inbox path is accepted when it is an
 * allowed root, and that containment still rejects it when it is NOT.
 */
import { describe, it, expect } from "vite-plus/test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPhotoStore } from "../src/photo-store.ts";
import { makeFakeDeps } from "./fake-drive.ts";

// A minimal valid 1x1 PNG (bytes are all that matters for the dedupe/hash path).
const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4" +
    "890000000a49444154789c6360000002000154a24f590000000049454e44ae42" +
    "6082",
  "hex",
);

/** A holder dir with a `cache` subdir (the default root) and an `inbox` subdir
 * that is its SIBLING — mirroring `.dev/cache` + `.dev/inbox` in production. */
function makeRoots() {
  const dir = mkdtempSync(join(tmpdir(), "justus-inbox-"));
  const cacheDir = join(dir, "cache");
  const inboxDir = join(dir, "inbox");
  mkdirSync(cacheDir, { recursive: true });
  mkdirSync(inboxDir, { recursive: true });
  return { cacheDir, inboxDir };
}

function buildStore(importRoots: string[]) {
  const deps = makeFakeDeps({ importRoots });
  mkdirSync(deps.cacheDir, { recursive: true });
  return createPhotoStore(deps);
}

async function withActiveFolder(store: ReturnType<typeof createPhotoStore>) {
  await store.ready();
  const [createErr, created] = await store.createFolder("A");
  expect(createErr).toBeNull();
  const folderId = (created as { folder: { id: string } }).folder.id;
  await store.setActive(folderId);
  return folderId;
}

describe("#157 dev inbox import must be an allowed root", () => {
  it("accepts a file dropped into the inbox (sibling of cacheDir) when declared", async () => {
    const { cacheDir, inboxDir } = makeRoots();
    const store = buildStore([cacheDir, inboxDir]);

    const folderId = await withActiveFolder(store);
    const inboxPath = join(inboxDir, "dropped.png");
    writeFileSync(inboxPath, PNG_BYTES);

    const [err, photo] = await store.add(inboxPath);
    expect(err).toBeNull();
    expect(photo).not.toBeNull();
    expect((photo as { url: string }).url).toContain(folderId);

    await store.close();
  });

  it("still rejects an inbox file when the inbox is NOT an allowed root", async () => {
    const { cacheDir, inboxDir } = makeRoots();
    // Default roots = [cacheDir] only; inbox omitted → must be rejected.
    const store = buildStore([cacheDir]);

    await withActiveFolder(store);
    const inboxPath = join(inboxDir, "dropped.png");
    writeFileSync(inboxPath, PNG_BYTES);

    const [err] = await store.add(inboxPath);
    expect(err).not.toBeNull();
    expect((err as { message: string }).message).toMatch(/escapes allowed roots/i);

    await store.close();
  });
});
