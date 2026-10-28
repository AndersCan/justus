/**
 * Issue #195: every album is a drive of its own. A device used to write its
 * auto-created "My Photos" album and every album it joined as a Member to ONE
 * drive (its identity drive), and albums read photos by scanning drives, so a
 * photo added to one album leaked to the members of every other album. A
 * fresh install now has no album at all: photos only live in albums.
 */
import { describe, it, expect } from "vite-plus/test";
import { mkdirSync } from "node:fs";
import { createPhotoStore } from "../src/photo-store.ts";
import { joinAsMember, makeFakeDeps, type FakeDrive } from "./fake-drive.ts";

/** A device on the default fakes, whose drives are found by corestore
 * namespace, so the same deps reopen the same drives after a restart. */
function device(name: string) {
  const deps = makeFakeDeps({ deviceName: name });
  mkdirSync(deps.cacheDir, { recursive: true });
  const identity = () => deps.makeDrive(deps.makeCorestore("")) as FakeDrive;
  return { deps, store: createPhotoStore(deps), identity };
}

const names = (photos: Array<{ name: string }>) =>
  photos.map((p) => p.name).sort((a, b) => a.localeCompare(b));

describe("#195 each album is its own drive", () => {
  it("keeps a photo in the album it was added to", async () => {
    const [x, y, z] = [device("X"), device("Y"), device("Z")];
    await Promise.all([x.store.ready(), y.store.ready(), z.store.ready()]);

    // A fresh install has no album to add photos to.
    expect((await x.store.folders()).folders).toEqual([]);
    expect((await x.store.addBytes("lost.jpg", new Uint8Array([0])))[0]).not.toBeNull();

    // X starts Cats; Y starts Wedding, Z starts Trip; X is a Member of both.
    const cats = (await x.store.createFolder("Cats"))[1]!.folder;
    const wedding = (await y.store.createFolder("Wedding 2026"))[1]!.folder;
    const trip = (await z.store.createFolder("Trip"))[1]!.folder;
    const inWedding = await joinAsMember(y.store, wedding.id, x.store, wedding.shareKey);
    const inTrip = await joinAsMember(z.store, trip.id, x.store, trip.shareKey);
    // A drive per album, none of them the identity drive.
    const xIdentity = x.identity().key.toString("hex");
    expect(new Set([inWedding, inTrip, xIdentity]).size).toBe(3);

    const xFolders = (await x.store.folders()).folders;
    const xWedding = xFolders.find((f) => f.shareKey === wedding.shareKey)!;
    expect(cats.shareKey).not.toBe(xIdentity);

    const bytes = (n: number) => new Uint8Array([n, n + 1, n + 2]);
    expect((await x.store.addBytes("cat.jpg", bytes(1), cats.id))[0]).toBeNull();
    expect((await x.store.addBytes("vows.jpg", bytes(2), xWedding.id))[0]).toBeNull();

    // The Admins see only what was added to their album.
    expect(names(await y.store.list())).toEqual(["vows.jpg"]);
    expect(names(await z.store.list())).toEqual([]);

    // X sees each photo once, in its own album.
    const all = await x.store.list({ all: true });
    const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
    expect([...all].sort(byName).map((p) => [p.name, p.folderId])).toEqual([
      ["cat.jpg", cats.id],
      ["vows.jpg", xWedding.id],
    ]);

    // Nothing is written to the identity drive.
    expect(x.identity().countPhotos()).toBe(0);

    await Promise.all([x.store.close(), y.store.close(), z.store.close()]);
  });

  it("reopens the same album drive after a restart, so the membership holds", async () => {
    const [x, y] = [device("X"), device("Y")];
    await Promise.all([x.store.ready(), y.store.ready()]);
    const wedding = (await y.store.createFolder("Wedding 2026"))[1]!.folder;
    const memberKey = await joinAsMember(y.store, wedding.id, x.store, wedding.shareKey);
    await x.store.close();

    const restarted = createPhotoStore(x.deps);
    await restarted.ready();
    const folder = (await restarted.folders()).folders.find(
      (f) => f.shareKey === wedding.shareKey,
    )!;
    expect(folder.role).toBe("member");
    expect(folder.driveKey).toBe(memberKey);

    await Promise.all([restarted.close(), y.store.close()]);
  });
});
