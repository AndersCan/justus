/**
 * Before #195 a device's first album *was* its identity drive, so an upgraded
 * device's `justus.json` holds a creator album whose `shareKey` equals the
 * identity drive's key. `setup()` opened a second Hyperdrive on that key next
 * to the open identity drive, whose `ready()` never settles: `store.ready()`
 * hung, the runtime never started, and the app stayed blank.
 *
 * Real Corestore + Hyperdrive, because the fakes hand back the same instance.
 */
import { makeTmpDir } from "./tmp-dirs.ts";
import { describe, it, expect } from "vite-plus/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Corestore from "corestore";
import Hyperdrive from "hyperdrive";
import { createHyperDriveStore } from "../src/adapters/hyper-drive-store.ts";
import { createPhotoStore } from "../src/photo-store.ts";
import { fakeStoreDeps } from "./fakes/fake-store-deps.ts";

const withTimeout = <T>(p: Promise<T>, ms: number) =>
  Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), ms)),
  ]);

function realDeps(storageDir: string) {
  const cacheDir = join(storageDir, "cache");
  mkdirSync(cacheDir, { recursive: true });
  const drives = createHyperDriveStore(join(storageDir, "corestore"));
  return fakeStoreDeps({
    storageDir,
    cacheDir,
    drives,
  });
}

describe("a pre-#195 album that is the identity drive", () => {
  it("boots instead of hanging in ready()", async () => {
    const storageDir = makeTmpDir("justus-legacy-");

    // The identity drive: the store opens it as the corestore's default drive.
    const cs = new Corestore(join(storageDir, "corestore"));
    const identity = new Hyperdrive(cs);
    await identity.ready();
    const identityKey = identity.key.toString("hex");
    await identity.close();
    await cs.close();

    // The state a pre-#195 install persisted: its album is the identity drive.
    const legacy = {
      version: 2,
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

  it("deleting a pre-#195 album keeps the identity drive's device file", async () => {
    const storageDir = makeTmpDir("justus-legacy-");
    const cs = new Corestore(join(storageDir, "corestore"));
    const identity = new Hyperdrive(cs);
    await identity.ready();
    const identityKey = identity.key.toString("hex");
    await identity.close();
    await cs.close();
    const legacy = {
      version: 2,
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
    const deps = realDeps(storageDir);
    const store = createPhotoStore(deps);
    await withTimeout(store.ready(), 5_000);
    expect((await store.deleteAlbum("legacy-1"))[0]).toBeNull();
    const [error, drive] = await deps.drives.open(identityKey, { timeoutMs: 2_000 });
    expect(error).toBeNull();
    const paths: string[] = [];
    for await (const entry of drive!.list("/")) paths.push(entry.path);
    expect(paths).toContain("/device.json");
    await store.close();
  });
});
