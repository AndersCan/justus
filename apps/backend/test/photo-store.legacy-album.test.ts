/**
 * Before #195 a device's first album *was* its identity drive, so an upgraded
 * device's `justus.json` holds a creator album whose `shareKey` equals the
 * identity drive's key. `setup()` opened a second Hyperdrive on that key next
 * to the open identity drive, whose `ready()` never settles: `store.ready()`
 * hung, the runtime never started, and the app stayed blank.
 *
 * Real Corestore + Hyperdrive, because the fakes hand back the same instance.
 */
import { describe, it, expect } from "vite-plus/test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Corestore from "corestore";
import Hyperdrive from "hyperdrive";
import { createPhotoStore } from "../src/photo-store.ts";
import { makeFakeDeps } from "./fake-drive.ts";

const withTimeout = <T>(p: Promise<T>, ms: number) =>
  Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), ms)),
  ]);

function realDeps(storageDir: string) {
  const cacheDir = join(storageDir, "cache");
  mkdirSync(cacheDir, { recursive: true });
  return makeFakeDeps({
    storageDir,
    cacheDir,
    makeCorestore: (dir) => new Corestore(dir),
    makeDrive: (cs, key) => new Hyperdrive(cs as never, key),
  });
}

describe("a pre-#195 album that is the identity drive", () => {
  it("boots instead of hanging in ready()", async () => {
    const storageDir = mkdtempSync(join(tmpdir(), "justus-legacy-"));

    // The identity drive: the store opens it as the corestore's default drive.
    const cs = new Corestore(join(storageDir, "corestore"));
    const identity = new Hyperdrive(cs);
    await identity.ready();
    const identityKey = identity.key.toString("hex");
    await identity.close();
    await cs.close();

    // The state a pre-#195 install persisted: its album is the identity drive.
    const legacy = {
      name: "Upgraded",
      activeFolderId: "legacy-1",
      folders: [
        {
          id: "legacy-1",
          name: "My Photos",
          role: "creator",
          shareKey: identityKey,
          driveKey: identityKey,
          createdAt: 0,
        },
      ],
    };
    writeFileSync(join(storageDir, "justus.json"), JSON.stringify(legacy), "utf8");

    const store = createPhotoStore(realDeps(storageDir));
    await withTimeout(store.ready(), 5_000);
    const folders = (await store.folders()).folders;
    expect(folders.map((f) => [f.shareKey, f.role])).toEqual([[identityKey, "creator"]]);
    await store.close();
  });
});
