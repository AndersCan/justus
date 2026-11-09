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
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Corestore from "corestore";
import Hyperdrive from "hyperdrive";
import { createHyperDriveStore } from "../src/adapters/hyper-drive-store.ts";
import { createPhotoStore } from "../src/photo-store.ts";
import type { Drive } from "../src/ports/drive-store.ts";
import { clearOldAlbumOffIdentity } from "../src/rotate-album.ts";
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

const album = (identityKey: string, shareKey: string) => ({
  id: "legacy-1",
  name: "My Photos",
  role: "creator",
  shareKey,
  driveKey: identityKey,
  createdAt: 0,
});

/** An identity drive as a pre-#195 phone left it: the album's files next to /device.json. */
async function seedIdentity(storageDir: string, withAlbum: boolean): Promise<string> {
  const cs = new Corestore(join(storageDir, "corestore"));
  const identity = new Hyperdrive(cs);
  await identity.ready();
  const put = (path: string, text: string) => identity.put(path, Buffer.from(text));
  await put("/device.json", '{"name":"Nils"}');
  await put("/requests.json", '{"asks":["keep me"]}');
  if (withAlbum) {
    await put("/folder.json", '{"name":"My Photos"}');
    await put("/members.json", '{"members":["secret"]}');
    await put("/photos/p1.jpg", "photo-bytes");
    await put("/thumbs/p1.webp", "thumb-bytes");
  }
  const key = identity.key.toString("hex");
  await identity.close();
  await cs.close();
  return key;
}

async function pathsOf(drive: Drive): Promise<string[]> {
  const out: string[] = [];
  for await (const entry of drive.list("/")) out.push(entry.path);
  return out.sort();
}

async function readable(deps: ReturnType<typeof realDeps>, key: string, v: number, path: string) {
  try {
    const [err, old] = await deps.drives.openAt(key, v, { timeoutMs: 1_000 });
    if (err) return false;
    return (await withTimeout(old.readBytes(path), 1_000)) !== undefined;
  } catch {
    return false;
  }
}

describe("clearing a pre-#195 album off the identity drive", () => {
  it("a state 1 phone moves its album and leaves nothing of it on the identity drive", async () => {
    const storageDir = makeTmpDir("justus-legacy-");
    const identityKey = await seedIdentity(storageDir, true);
    writeFileSync(
      join(storageDir, "justus.json"),
      JSON.stringify({
        version: 1,
        name: "Nils",
        activeFolderId: "legacy-1",
        folders: [album(identityKey, identityKey)],
      }),
      "utf8",
    );
    const deps = realDeps(storageDir);
    const store = createPhotoStore(deps);
    await withTimeout(store.ready(), 15_000);
    const [moved] = (await store.folders()).folders;
    expect(moved!.shareKey).not.toBe(identityKey);
    const [, newDrive] = await deps.drives.open(moved!.shareKey, { timeoutMs: 2_000 });
    expect(await pathsOf(newDrive!)).toContain("/photos/p1.jpg");
    const [, identity] = await deps.drives.open(identityKey, { timeoutMs: 2_000 });
    expect(await pathsOf(identity!)).toEqual(["/device.json", "/links.json", "/requests.json"]);
    const version = identity!.version();
    for (let v = 1; v < version; v++) {
      expect(await readable(deps, identityKey, v, "/photos/p1.jpg")).toBe(false);
      expect(await readable(deps, identityKey, v, "/members.json")).toBe(false);
    }
    await store.close();
  }, 30_000);

  it("clears a phone that moved earlier, and a second boot writes nothing", async () => {
    const storageDir = makeTmpDir("justus-legacy-");
    const identityKey = await seedIdentity(storageDir, true);
    writeFileSync(
      join(storageDir, "justus.json"),
      JSON.stringify({ version: 2, name: "Nils", folders: [] }),
      "utf8",
    );
    const first = realDeps(storageDir);
    const store = createPhotoStore(first);
    await withTimeout(store.ready(), 15_000);
    const [, identity] = await first.drives.open(identityKey, { timeoutMs: 2_000 });
    expect(await pathsOf(identity!)).toEqual(["/device.json", "/links.json", "/requests.json"]);
    await store.close();

    const second = realDeps(storageDir);
    const again = createPhotoStore(second);
    await withTimeout(again.ready(), 15_000);
    const [, identity2] = await second.drives.open(identityKey, { timeoutMs: 2_000 });
    const before = identity2!.version();
    await again.close();
    const third = realDeps(storageDir);
    const last = createPhotoStore(third);
    await withTimeout(last.ready(), 15_000);
    const [, identity3] = await third.drives.open(identityKey, { timeoutMs: 2_000 });
    // Only the swarm key in /device.json may be rewritten on boot.
    expect(identity3!.version() - before).toBeLessThanOrEqual(1);
    expect(await pathsOf(identity3!)).toEqual(["/device.json", "/links.json", "/requests.json"]);
    await last.close();
  });

  it("a store that stops partway through the clear is finished by the next start", async () => {
    const storageDir = makeTmpDir("justus-legacy-");
    const identityKey = await seedIdentity(storageDir, true);
    writeFileSync(
      join(storageDir, "justus.json"),
      JSON.stringify({ version: 2, name: "Nils", folders: [] }),
      "utf8",
    );
    const real = realDeps(storageDir);
    const realOpenOwn = real.drives.openOwn.bind(real.drives);
    let dels = 0;
    const failing = {
      ...real,
      drives: {
        ...real.drives,
        openOwn: async (...args: Parameters<typeof realOpenOwn>) => {
          const drive = await realOpenOwn(...args);
          return new Proxy(drive, {
            get(target, prop) {
              if (prop === "del") {
                return async (path: string) => {
                  dels++;
                  if (dels >= 2) throw new Error("stopped partway");
                  return target.del(path);
                };
              }
              const value = Reflect.get(target, prop);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        },
      },
    } as typeof real;
    const first = createPhotoStore(failing);
    await withTimeout(first.ready(), 15_000);
    expect(dels).toBeGreaterThanOrEqual(2);
    await first.close();

    const second = realDeps(storageDir);
    const again = createPhotoStore(second);
    await withTimeout(again.ready(), 15_000);
    const [, identity] = await second.drives.open(identityKey, { timeoutMs: 2_000 });
    expect(await pathsOf(identity!)).toEqual(["/device.json", "/links.json", "/requests.json"]);
    await again.close();
    const saved = JSON.parse(readFileSync(join(storageDir, "justus.json"), "utf8"));
    expect(saved.identityClearPending).toBeUndefined();
  }, 30_000);

  it("leaves the identity drive alone while an album still lives on it", async () => {
    const storageDir = makeTmpDir("justus-legacy-");
    const identityKey = await seedIdentity(storageDir, true);
    writeFileSync(
      join(storageDir, "justus.json"),
      JSON.stringify({
        version: 2,
        name: "Nils",
        activeFolderId: "legacy-1",
        folders: [album(identityKey, identityKey)],
      }),
      "utf8",
    );
    const deps = realDeps(storageDir);
    const store = createPhotoStore(deps);
    await withTimeout(store.ready(), 15_000);
    const [, identity] = await deps.drives.open(identityKey, { timeoutMs: 2_000 });
    expect(await pathsOf(identity!)).toContain("/photos/p1.jpg");
    await store.close();
  });

  it("does nothing on an identity drive with no /folder.json", async () => {
    const storageDir = makeTmpDir("justus-legacy-");
    const identityKey = await seedIdentity(storageDir, false);
    const deps = realDeps(storageDir);
    const store = createPhotoStore(deps);
    await withTimeout(store.ready(), 15_000);
    const [, identity] = await deps.drives.open(identityKey, { timeoutMs: 2_000 });
    expect(await pathsOf(identity!)).toEqual(["/device.json", "/links.json", "/requests.json"]);
    await store.close();
  });

  it("keeps the phone's own ask outbox and reports 'nothing' the second time", async () => {
    const storageDir = makeTmpDir("justus-legacy-");
    await seedIdentity(storageDir, true);
    const deps = realDeps(storageDir);
    await deps.drives.ready();
    const identity = await deps.drives.openOwn();
    expect(await clearOldAlbumOffIdentity(identity, noMark)).toEqual([null, "cleared"]);
    expect(await pathsOf(identity)).toEqual(["/device.json", "/requests.json"]);
    expect(new TextDecoder().decode(await identity.readBytes("/requests.json"))).toBe(
      '{"asks":["keep me"]}',
    );
    const version = identity.version();
    expect(await clearOldAlbumOffIdentity(identity, noMark)).toEqual([null, "nothing"]);
    expect(identity.version()).toBe(version);
  });

  it("returns an error value when /device.json is missing", async () => {
    const storageDir = makeTmpDir("justus-legacy-");
    await seedIdentity(storageDir, true);
    const deps = realDeps(storageDir);
    await deps.drives.ready();
    const identity = await deps.drives.openOwn();
    await identity.del("/device.json");
    const [err, result] = await clearOldAlbumOffIdentity(identity, noMark);
    expect(err?.message).toBe("clear: cannot read /device.json");
    expect(result).toBeNull();
    expect(await pathsOf(identity)).toContain("/photos/p1.jpg");
  });
});

const noMark = { resume: false, markPending: () => {} };

async function seededIdentity(): Promise<{ identity: Drive; deps: ReturnType<typeof realDeps> }> {
  const storageDir = makeTmpDir("justus-legacy-");
  await seedIdentity(storageDir, true);
  const deps = realDeps(storageDir);
  await deps.drives.ready();
  return { identity: await deps.drives.openOwn(), deps };
}

describe("a clear that stops partway is finished next time", () => {
  it("a delete that throws leaves the work to do when resume is set", async () => {
    const { identity } = await seededIdentity();
    let calls = 0;
    const flaky: Drive = Object.create(identity);
    flaky.del = async (path: string) => {
      if (++calls >= 2) throw new Error("killed");
      return identity.del(path);
    };
    let marked = 0;
    const [err] = await clearOldAlbumOffIdentity(flaky, {
      resume: false,
      markPending: () => marked++,
    });
    expect(err?.message).toBe("killed");
    expect(marked).toBe(1);
    expect(
      await clearOldAlbumOffIdentity(identity, { resume: true, markPending: () => {} }),
    ).toEqual([null, "cleared"]);
    expect(await pathsOf(identity)).toEqual(["/device.json", "/requests.json"]);
  });

  it("a keepOnly error is retried and the outbox survives", async () => {
    const { identity } = await seededIdentity();
    const failing: Drive = Object.create(identity);
    failing.keepOnly = async () => [new Error("disk full"), null];
    const [err] = await clearOldAlbumOffIdentity(failing, noMark);
    expect(err?.message).toBe("disk full");
    expect(await pathsOf(identity)).toEqual(["/device.json", "/requests.json"]);
    expect(
      await clearOldAlbumOffIdentity(identity, { resume: true, markPending: () => {} }),
    ).toEqual([null, "cleared"]);
  });

  it("older versions remaining is an error value and the outbox survives", async () => {
    const { identity } = await seededIdentity();
    const lying: Drive = Object.create(identity);
    lying.keepOnly = async () => [null, { olderVersionsCleared: false }];
    const [err, result] = await clearOldAlbumOffIdentity(lying, noMark);
    expect(err?.message).toBe("clear: older versions of the identity drive remain");
    expect(result).toBeNull();
    expect(await pathsOf(identity)).toEqual(["/device.json", "/requests.json"]);
  });

  it("does nothing without /folder.json unless resume is set", async () => {
    const { identity } = await seededIdentity();
    await clearOldAlbumOffIdentity(identity, noMark);
    expect(await clearOldAlbumOffIdentity(identity, noMark)).toEqual([null, "nothing"]);
    expect(
      await clearOldAlbumOffIdentity(identity, { resume: true, markPending: () => {} }),
    ).toEqual([null, "cleared"]);
  });
});
