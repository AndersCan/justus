/**
 * The Photos page shows every album at once: `list({ all })` spans albums,
 * tags each photo with its album and whether this device added it, and
 * add/remove can target an album without switching the active one.
 */
import { describe, it, expect } from "vite-plus/test";
import { mkdirSync } from "node:fs";
import { createPhotoStore } from "../src/photo-store.ts";
import { createFakeHub } from "./fakes/fake-world.ts";
import { fakeStoreDeps, joinAsMember } from "./fakes/fake-store-deps.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** N stores on one hub, so they share drives the way replicating phones do. */
function buildDevices(names: string[]) {
  const hub = createFakeHub();
  const devices = names.map((name) => {
    const deps = fakeStoreDeps({ hub, deviceName: name });
    mkdirSync(deps.cacheDir, { recursive: true });
    const store = createPhotoStore(deps);
    return { store, deps };
  });
  return { devices };
}

describe("photos across albums", () => {
  it("lists every album's photos, tagged by album and author, and targets adds/removes", async () => {
    const { devices } = buildDevices(["X", "Y"]);
    const [x, y] = devices;
    await x.store.ready();
    await y.store.ready();

    // X starts "Wedding 2026" and "Cats"; Y joins Wedding as a member and adds
    // a photo.
    const cats = (await x.store.createFolder("Cats"))[1]!.folder;
    const created = await x.store.createFolder("Wedding 2026");
    const wedding = created[1]!.folder;
    await joinAsMember(x.store, wedding.id, y.store, wedding.shareKey);
    const yWedding = (await y.store.folders()).folders.find(
      (f) => f.shareKey === wedding.shareKey,
    )!;
    const theirs = await y.store.addBytes("vows.jpg", new Uint8Array([1, 2, 3]), yWedding.id);
    expect(theirs[0]).toBeNull();
    // Let the creator's async member-drive refresh open Y's drive.
    await sleep(600);

    // X adds to both albums by id, whichever one is active.
    await x.store.setActive(cats.id);
    const toWedding = await x.store.addBytes("cake.jpg", new Uint8Array([4, 5, 6]), wedding.id);
    const toMine = await x.store.addBytes("cat.jpg", new Uint8Array([7, 8, 9]), cats.id);
    expect(toWedding[1]).toMatchObject({ folderId: wedding.id, mine: true });
    expect(toMine[1]).toMatchObject({ folderId: cats.id, mine: true });

    const all = await x.store.list({ all: true });
    const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
    expect([...all].sort(byName).map((p) => [p.name, p.folderId, p.mine])).toEqual([
      ["cake.jpg", wedding.id, true],
      ["cat.jpg", cats.id, true],
      ["vows.jpg", wedding.id, false],
    ]);
    const times = all.map((p) => p.addedAt);
    expect(times).toEqual([...times].sort((a, b) => b - a));

    // Without `all`, list stays the active album's.
    expect((await x.store.list()).map((p) => p.name)).toEqual(["cat.jpg"]);

    // A targeted remove leaves the active album alone.
    const removed = await x.store.remove(toWedding[1]!.id, wedding.id);
    expect(removed[0]).toBeNull();
    const after = (await x.store.list({ all: true })).sort(byName).map((p) => p.name);
    expect(after).toEqual(["cat.jpg", "vows.jpg"]);

    await x.store.close();
    await y.store.close();
  });
});
