/**
 * A phone notices photos someone else deleted and pushes a "deleted" change
 * to its screen, naming the deleter only when the drives prove who it was.
 * Two or three phones on the checked fakes share one hub.
 */
import { describe, it, expect } from "vite-plus/test";
import { mkdirSync } from "node:fs";
import { createPhotoStore, type PhotoStoreDeps } from "../src/photo-store.ts";
import { createFakeHub, addFakeNode, setFakeNodeConnected } from "./fakes/fake-world.ts";
import {
  FakeLoopbackServer,
  fakeStoreDeps,
  joinAsMember,
  restarted,
} from "./fakes/fake-store-deps.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Push = Parameters<PhotoStoreDeps["onChanged"]>[0];

async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 5_000;
  let ok = await check();
  while (!ok && Date.now() < deadline) {
    await sleep(20);
    ok = await check();
  }
  expect(ok).toBe(true);
}

function phoneDeps(hub: ReturnType<typeof createFakeHub>, deviceName: string, pushes: Push[]) {
  const node = addFakeNode(hub);
  setFakeNodeConnected({ hub, node, connected: true });
  const deps = fakeStoreDeps({
    hub,
    node,
    deviceName,
    onChanged: (p: Push) => void pushes.push(p),
  });
  mkdirSync(deps.cacheDir, { recursive: true });
  return deps;
}

const deletedPushes = (pushes: Push[]) => pushes.filter((p) => p.cause === "deleted");

/** Anna (Admin) and Nils (Collaborator) in "Trip", with Cara as a second Collaborator when asked. */
async function album(options: { cara?: boolean } = {}) {
  const hub = createFakeHub();
  const annaPushes: Push[] = [];
  const nilsPushes: Push[] = [];
  const caraPushes: Push[] = [];
  const annaDeps = phoneDeps(hub, "Anna", annaPushes);
  const anna = createPhotoStore(annaDeps);
  const nilsDeps = phoneDeps(hub, "Nils", nilsPushes);
  const nils = createPhotoStore(nilsDeps);
  await anna.ready();
  await nils.ready();
  const created = await anna.createFolder("Trip");
  const folderId = created[1]!.folder.id;
  const shareKey = created[1]!.folder.shareKey;
  const nilsKey = await joinAsMember(anna, folderId, nils, shareKey);
  const nilsFolderId = (await nils.folders()).folders.find((f) => f.shareKey === shareKey)!.id;
  await nils.setActive(nilsFolderId);
  await anna.setActive(folderId);
  let cara: ReturnType<typeof createPhotoStore> | undefined;
  let caraFolderId = "";
  if (options.cara) {
    cara = createPhotoStore(phoneDeps(hub, "Cara", caraPushes));
    await cara.ready();
    await joinAsMember(anna, folderId, cara, shareKey);
    caraFolderId = (await cara.folders()).folders.find((f) => f.shareKey === shareKey)!.id;
    await cara.setActive(caraFolderId);
  }
  const close = async () => {
    await anna.close();
    await nils.close();
    await cara?.close();
  };
  return {
    anna,
    nils,
    cara,
    annaDeps,
    nilsDeps,
    annaPushes,
    nilsPushes,
    caraPushes,
    folderId,
    shareKey,
    nilsFolderId,
    caraFolderId,
    nilsKey,
    close,
  };
}

async function photoId(store: ReturnType<typeof createPhotoStore>, name: string) {
  return (await store.list()).find((p) => p.name === name)?.id ?? "";
}

describe("noticing photos someone else deleted", () => {
  it("the Admin deletes her own photo: the Collaborator is told, the Admin is not", async () => {
    const s = await album();
    await s.anna.addBytes("sun.jpg", new Uint8Array([1, 2, 3, 4]));
    await until(async () => (await s.nils.list()).some((p) => p.name === "sun.jpg"));
    await s.anna.list();
    await s.anna.remove(await photoId(s.anna, "sun.jpg"));
    await until(async () => !(await s.nils.list()).some((p) => p.name === "sun.jpg"));
    expect({
      nils: deletedPushes(s.nilsPushes),
      anna: deletedPushes(s.annaPushes),
    }).toEqual({
      nils: [
        {
          cause: "deleted",
          folderId: s.nilsFolderId,
          deleted: {
            albumName: "Trip",
            photos: [
              { name: "sun.jpg", adderName: "Anna", mine: false, held: false, deletedBy: "Anna" },
            ],
          },
        },
      ],
      anna: [],
    });
    await s.close();
  });

  it("the Admin deletes the Collaborator's photo: the Collaborator is told it was theirs", async () => {
    const s = await album();
    await s.nils.addBytes("mine.jpg", new Uint8Array([5, 6, 7, 8]));
    await until(async () => (await s.anna.list()).some((p) => p.name === "mine.jpg"));
    await s.nils.list();
    await s.anna.remove(await photoId(s.anna, "mine.jpg"));
    await s.anna.list();
    await until(async () => !(await s.nils.list()).some((p) => p.name === "mine.jpg"));
    expect({
      nils: deletedPushes(s.nilsPushes).map((p) => p.deleted?.photos),
      anna: deletedPushes(s.annaPushes),
    }).toEqual({
      nils: [[{ name: "mine.jpg", adderName: "Nils", mine: true, held: true, deletedBy: "Anna" }]],
      anna: [],
    });
    await s.close();
  });

  it("the Collaborator deletes their own photo: the Admin is told, without a name while the adder's name is not known", async () => {
    const s = await album();
    await s.nils.addBytes("mine.jpg", new Uint8Array([5, 6, 7, 8]));
    await until(async () => (await s.anna.list()).some((p) => p.name === "mine.jpg"));
    await s.anna.list();
    await s.nils.remove(await photoId(s.nils, "mine.jpg"));
    await until(async () => !(await s.anna.list()).some((p) => p.name === "mine.jpg"));
    expect({
      anna: deletedPushes(s.annaPushes).map((p) => p.deleted?.photos),
      nils: deletedPushes(s.nilsPushes),
    }).toEqual({
      anna: [[{ name: "mine.jpg", adderName: "New member", mine: false, held: false }]],
      nils: [],
    });
    await s.close();
  });

  it("a list and a status running together give one push, not two", async () => {
    const s = await album();
    await s.anna.addBytes("sun.jpg", new Uint8Array([1, 2, 3, 4]));
    await until(async () => (await s.nils.list()).some((p) => p.name === "sun.jpg"));
    await s.anna.remove(await photoId(s.anna, "sun.jpg"));
    await until(async () => {
      await Promise.all([s.nils.list(), s.nils.status(), s.nils.list(), s.nils.status()]);
      return (await s.nils.list()).length === 0;
    });
    await sleep(100);
    expect(deletedPushes(s.nilsPushes)).toHaveLength(1);
    await s.close();
  });

  it("a listing that started before a newer one finished is dropped, so the delete is told once", async () => {
    const s = await album();
    await s.anna.addBytes("sun.jpg", new Uint8Array([1, 2, 3, 4]));
    await until(async () => (await s.nils.list()).some((p) => p.name === "sun.jpg"));
    // From now on, the first read of the removed list on Nils's phone waits until released.
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let gated = false;
    const [, folderDrive] = await s.nilsDeps.drives.open(s.shareKey, { timeoutMs: 1000 });
    const list = folderDrive!.list.bind(folderDrive!);
    folderDrive!.list = (path: string) => {
      const entries = list(path);
      if (path !== "/photos" || gated) return entries;
      gated = true;
      return (async function* () {
        const seen = [];
        for await (const entry of entries) seen.push(entry);
        await gate;
        yield* seen;
      })();
    };
    const slow = s.nils.list();
    await until(async () => gated);
    await s.anna.remove(await photoId(s.anna, "sun.jpg"));
    await sleep(200);
    await s.nils.list();
    release();
    await slow;
    await s.nils.list();
    await sleep(100);
    expect(deletedPushes(s.nilsPushes)).toHaveLength(1);
    await s.close();
  });

  it("a Collaborator made a Viewer does not make the Admin's list report deletes", async () => {
    const s = await album();
    await s.nils.addBytes("mine.jpg", new Uint8Array([5, 6, 7, 8]));
    await until(async () => (await s.anna.list()).some((p) => p.name === "mine.jpg"));
    await s.anna.list();
    await s.anna.makeViewer(s.folderId, s.nilsKey);
    await s.anna.list();
    await sleep(100);
    expect(deletedPushes(s.annaPushes)).toEqual([]);
    await s.close();
  });

  it("the Admin removing a member who added photos tells the Admin nothing about a delete", async () => {
    const s = await album({ cara: true });
    await s.nils.addBytes("mine.jpg", new Uint8Array([5, 6, 7, 8]));
    await until(async () => (await s.cara!.list()).some((p) => p.name === "mine.jpg"));
    await s.cara!.list();
    expect((await s.anna.removeMember(s.folderId, s.nilsKey))[0]).toBeNull();
    await sleep(200);
    await s.cara!.list();
    await s.anna.list();
    expect({ cara: deletedPushes(s.caraPushes), anna: deletedPushes(s.annaPushes) }).toEqual({
      cara: [],
      anna: [],
    });
    await s.close();
  });

  it("the Admin removing a member who added photos tells a third phone nothing about a delete", async () => {
    const hub = createFakeHub();
    const pushes: Record<string, Push[]> = { anna: [], nils: [], cara: [] };
    const make = (name: string, key: string) => {
      const deps = { ...phoneDeps(hub, name, pushes[key]!), server: new FakeLoopbackServer() };
      return { deps, store: createPhotoStore(deps) };
    };
    const anna = make("Anna", "anna");
    const nils = make("Nils", "nils");
    const cara = make("Cara", "cara");
    for (const p of [anna, nils, cara]) await p.store.ready();
    const created = await anna.store.createFolder("Trip");
    const { id: folderId, shareKey, invite } = created[1]!.folder;
    const identity = (anna.store.debugState() as { identityDrive: string }).identityDrive;
    const keys: Record<string, string> = {};
    const ids: Record<string, string> = {};
    for (const [name, who] of [
      ["nils", nils],
      ["cara", cara],
    ] as const) {
      await who.store.ask({
        code: invite!.code,
        owner: identity,
        albumName: "Trip",
        ownerName: "Anna",
      });
      let requesterKey = "";
      await until(async () => {
        requesterKey = (await anna.store.requests()).requests[0]?.requesterKey ?? "";
        return requesterKey !== "";
      });
      keys[name] = requesterKey;
      expect((await anna.store.respond(folderId, requesterKey, true, "member"))[0]).toBeNull();
      await until(async () => (await who.store.folders()).folders[0]?.shareKey === shareKey);
      ids[name] = (await who.store.folders()).folders[0]!.id;
      await who.store.setActive(ids[name]!);
    }
    await nils.store.addBytes("mine.jpg", new Uint8Array([5, 6, 7, 8]), ids.nils);
    await until(async () => (await cara.store.list()).some((p) => p.name === "mine.jpg"));
    await cara.store.list();
    expect((await anna.store.removeMember(folderId, keys.nils!))[0]).toBeNull();
    await until(async () => {
      const moved = (await cara.store.folders()).folders.find((f) => f.id === ids.cara);
      return moved?.shareKey !== shareKey;
    });
    await until(async () => !(await cara.store.list()).some((p) => p.name === "mine.jpg"));
    await cara.store.list();
    await sleep(100);
    expect(deletedPushes(pushes.cara!)).toEqual([]);
    for (const p of [anna, nils, cara]) await p.store.close();
  }, 40_000);

  it("a member leaving is not a delete", async () => {
    const s = await album();
    await s.nils.addBytes("mine.jpg", new Uint8Array([5, 6, 7, 8]));
    await until(async () => (await s.anna.list()).some((p) => p.name === "mine.jpg"));
    await s.anna.list();
    await s.nils.leaveAlbum(s.nilsFolderId);
    await until(async () => !(await s.anna.list()).some((p) => p.name === "mine.jpg"));
    await s.anna.list();
    expect(deletedPushes(s.annaPushes)).toEqual([]);
    await s.close();
  });

  it("the Admin deleting the album tells nobody a photo was deleted", async () => {
    const s = await album();
    await s.anna.addBytes("sun.jpg", new Uint8Array([1, 2, 3, 4]));
    await until(async () => (await s.nils.list()).some((p) => p.name === "sun.jpg"));
    await s.nils.list();
    expect((await s.anna.deleteAlbum(s.folderId))[0]).toBeNull();
    await until(async () => !(await s.nils.list()).some((p) => p.name === "sun.jpg"));
    await s.nils.list();
    expect(deletedPushes(s.nilsPushes)).toEqual([]);
    await s.close();
  });

  it("a delete made while an album was archived is not told after it is restored", async () => {
    const s = await album();
    await s.anna.addBytes("sun.jpg", new Uint8Array([1, 2, 3, 4]));
    await until(async () => (await s.nils.list()).some((p) => p.name === "sun.jpg"));
    await s.nils.list({ all: true });
    expect((await s.nils.archiveAlbum(s.nilsFolderId))[0]).toBeNull();
    await s.nils.list({ all: true });
    await s.anna.remove(await photoId(s.anna, "sun.jpg"));
    await sleep(200);
    expect((await s.nils.restoreAlbum(s.nilsFolderId))[0]).toBeNull();
    await s.nils.list({ all: true });
    await sleep(100);
    expect(deletedPushes(s.nilsPushes)).toEqual([]);
    await s.close();
  });

  it("a restarted phone has no earlier listing, so it tells nothing", async () => {
    const s = await album();
    await s.anna.addBytes("sun.jpg", new Uint8Array([1, 2, 3, 4]));
    await until(async () => (await s.nils.list()).some((p) => p.name === "sun.jpg"));
    await s.nils.close();
    await s.anna.remove(await photoId(s.anna, "sun.jpg"));
    const pushes: Push[] = [];
    const again = createPhotoStore({
      ...restarted(s.nilsDeps),
      onChanged: (p: Push) => void pushes.push(p),
    });
    await again.ready();
    await again.list();
    await sleep(100);
    await again.list();
    expect(deletedPushes(pushes)).toEqual([]);
    await again.close();
    await s.anna.close();
  });

  async function openFull(
    store: ReturnType<typeof createPhotoStore>,
    server: FakeLoopbackServer,
    name: string,
  ) {
    const photo = (await store.list()).find((p) => p.name === name)!;
    await server.getForTest(new URL(photo.url).pathname);
  }

  it("a photo the Collaborator opened is told as held, from the phone's own record", async () => {
    const s = await album();
    await s.anna.addBytes("a.jpg", new Uint8Array([1, 2, 3, 4]));
    await until(async () => (await s.nils.list()).some((p) => p.name === "a.jpg"));
    await openFull(s.nils, s.nilsDeps.server as FakeLoopbackServer, "a.jpg");
    await sleep(300);
    await s.anna.list();
    await s.anna.remove(await photoId(s.anna, "a.jpg"));
    await until(async () => !(await s.nils.list()).some((p) => p.name === "a.jpg"));
    await until(async () => deletedPushes(s.nilsPushes).length > 0);
    expect(deletedPushes(s.nilsPushes)[0]).toMatchObject({
      deleted: { photos: [{ name: "a.jpg", held: true }] },
    });
    await s.close();
  });

  it("an unreadable own record never says the photo had not reached the phone", async () => {
    const s = await album();
    await s.anna.addBytes("a.jpg", new Uint8Array([1, 2, 3, 4]));
    await s.anna.addBytes("b.jpg", new Uint8Array([5, 6, 7, 8]));
    await until(async () => (await s.nils.list()).length === 2);
    await openFull(s.nils, s.nilsDeps.server as FakeLoopbackServer, "a.jpg");
    await sleep(300);
    await s.nils.close();
    const pushes: Push[] = [];
    const deps = restarted(s.nilsDeps);
    const openOwn = deps.drives.openOwn.bind(deps.drives);
    deps.drives.openOwn = async (namespace?: string) => {
      const drive = await openOwn(namespace);
      const readSmall = drive.readSmall.bind(drive);
      drive.readSmall = async (...a: Parameters<typeof readSmall>) => {
        if (a[0] === "/holding.json") throw new Error("unreadable");
        return readSmall(...a);
      };
      return drive;
    };
    const again = createPhotoStore({ ...deps, onChanged: (p: Push) => void pushes.push(p) });
    await again.ready();
    await again.list();
    await openFull(again, deps.server as FakeLoopbackServer, "b.jpg");
    await sleep(300);
    await s.anna.list();
    await s.anna.remove(await photoId(s.anna, "a.jpg"));
    await until(async () => !(await again.list()).some((p) => p.name === "a.jpg"));
    await until(async () => deletedPushes(pushes).length > 0);
    const photo = (deletedPushes(pushes)[0] as any).deleted.photos[0];
    expect(photo.name).toBe("a.jpg");
    expect(photo.held).toBeUndefined();
    await again.close();
    await s.anna.close();
  });
});
