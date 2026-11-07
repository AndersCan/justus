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
import { createFakeHub, type FakeHub, type FakeNode } from "./fakes/fake-world.ts";
import { fakeStoreDeps, joinAsMember, restarted } from "./fakes/fake-store-deps.ts";

/** A device on the checked fakes; devices share drives through their hub. */
function device(hub: FakeHub, name: string) {
  const deps = fakeStoreDeps({ hub, deviceName: name });
  mkdirSync(deps.cacheDir, { recursive: true });
  const store = createPhotoStore(deps);
  const identity = () => (store.debugState() as { identityDrive: string }).identityDrive;
  return { deps, store, identity };
}

/** Photos stored under /photos/ in this node's copy of the drive. */
const photosOn = (node: FakeNode, key: string) =>
  [...(node.replicas.get(key)?.files.keys() ?? [])].filter((p) => p.startsWith("/photos/")).length;

const names = (photos: Array<{ name: string }>) =>
  photos.map((p) => p.name).sort((a, b) => a.localeCompare(b));

describe("#195 each album is its own drive", () => {
  it("keeps a photo in the album it was added to", async () => {
    const hub = createFakeHub();
    const [x, y, z] = [device(hub, "X"), device(hub, "Y"), device(hub, "Z")];
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
    const xIdentity = x.identity();
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
    expect(photosOn(x.deps.node, x.identity())).toBe(0);

    await Promise.all([x.store.close(), y.store.close(), z.store.close()]);
  });

  it("reopens the same album drive after a restart, so the membership holds", async () => {
    const hub = createFakeHub();
    const [x, y] = [device(hub, "X"), device(hub, "Y")];
    await Promise.all([x.store.ready(), y.store.ready()]);
    const wedding = (await y.store.createFolder("Wedding 2026"))[1]!.folder;
    const memberKey = await joinAsMember(y.store, wedding.id, x.store, wedding.shareKey);
    await x.store.close();

    const again = createPhotoStore(restarted(x.deps));
    await again.ready();
    const folder = (await again.folders()).folders.find((f) => f.shareKey === wedding.shareKey)!;
    expect(folder.role).toBe("member");
    expect(folder.driveKey).toBe(memberKey);

    await Promise.all([again.close(), y.store.close()]);
  });
});
