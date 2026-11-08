/**
 * A friend invited before a Remove can still Join after it: the Admin's phone
 * keeps the invite open through the code the friend's card carries.
 */
import { describe, it, expect } from "vite-plus/test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createPhotoStore } from "../src/photo-store.ts";
import { createFakeHub, addFakeNode, setFakeNodeConnected } from "./fakes/fake-world.ts";
import {
  FakeLoopbackServer,
  fakeStoreDeps,
  joinAsMember,
  restarted,
} from "./fakes/fake-store-deps.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function until(done: () => boolean | Promise<boolean>, ms = 3_000): Promise<void> {
  for (let waited = 0; waited < ms && !(await done()); waited += 20) await sleep(20);
}

function phone(hub: ReturnType<typeof createFakeHub>, deviceName: string) {
  const node = addFakeNode(hub);
  setFakeNodeConnected({ hub, node, connected: true });
  const server = new FakeLoopbackServer();
  const deps = fakeStoreDeps({ hub, node, deviceName, server });
  mkdirSync(deps.cacheDir, { recursive: true });
  return { deps, node, server, store: createPhotoStore(deps) };
}

const identityOf = (s: { store: { debugState(): unknown } }) =>
  (s.store.debugState() as { identityDrive: string }).identityDrive;

type Phone = ReturnType<typeof phone>;

/** Anna's "Trip" with Ben and Nils as Collaborators; Kim, Anna's friend, holds a Viewer invite. */
async function scene() {
  const hub = createFakeHub();
  const admin = phone(hub, "Anna");
  const ben = phone(hub, "Ben");
  const nils = phone(hub, "Nils");
  let kim = phone(hub, "Kim");
  (kim.deps as { isFriend?: (id: string) => boolean }).isFriend = (id) => id === identityOf(admin);
  for (const p of [admin, ben, nils, kim]) await p.store.ready();
  const created = await admin.store.createFolder("Trip");
  const folderId = created[1]!.folder.id;
  const shareKey = created[1]!.folder.shareKey;
  const keys = {
    ben: await joinAsMember(admin.store, folderId, ben.store, shareKey),
    nils: await joinAsMember(admin.store, folderId, nils.store, shareKey),
  };
  await until(async () => {
    const m = (await admin.store.status()).members;
    return m.length === 3 && m.every((x: { identity?: string }) => x.identity !== undefined);
  });
  expect((await admin.store.offerAlbum(folderId, identityOf(kim), "reader"))[0]).toBeNull();
  const invited = () =>
    (admin.store.debugState() as { folders: { invited?: string[] }[] }).folders[0]!.invited ?? [];
  await until(
    async () => (await kim.store.folders()).offers.length === 1 && invited().length === 1,
  );
  const card = async () => (await kim.store.folders()).offers[0]!;
  const saved = () => JSON.parse(readFileSync(join(admin.deps.storageDir, "justus.json"), "utf8"));
  const record = () => saved().folders.find((f: { id: string }) => f.id === folderId);
  const trip = async (p: Phone) => (await p.store.folders()).folders.find((f) => f.name === "Trip");
  const adminShareKey = async () => (await trip(admin))!.shareKey;
  const close = async () => {
    for (const p of [admin, ben, nils, kim]) await p.store.close();
  };
  return {
    hub,
    admin,
    ben,
    nils,
    folderId,
    keys,
    invited,
    card,
    record,
    trip,
    adminShareKey,
    close,
    get kim() {
      return kim;
    },
    set kim(p: Phone) {
      kim = p;
    },
  };
}

async function joinsOnNewKey(s: Awaited<ReturnType<typeof scene>>, ms = 8_000) {
  const card = await s.card();
  expect((await s.kim.store.joinOffer(card.code, card.owner))[0]).toBeNull();
  const want = await s.adminShareKey();
  await until(async () => (await s.trip(s.kim))?.shareKey === want, ms);
  return want;
}

describe("a friend invited before a Remove", () => {
  it("taps Join after the Remove and gets in on the new key", async () => {
    const s = await scene();
    expect((await s.admin.store.removeMember(s.folderId, s.keys.ben))[0]).toBeNull();
    const want = await joinsOnNewKey(s);
    const album = await s.trip(s.kim);
    expect(album?.shareKey).toBe(want);
    expect(album?.pending).toBeFalsy();
    expect(album?.role).toBe("reader");
    await until(async () => (await s.kim.store.folders()).offers.length === 0);
    expect((await s.kim.store.folders()).offers).toHaveLength(0);
    await until(() => s.invited().length === 0);
    expect(s.invited()).toHaveLength(0);
    expect(s.record().heldAsks?.[identityOf(s.kim)]).toBeUndefined();
    await s.close();
  });

  it("tapped Join while away and gets in after a Remove", async () => {
    const s = await scene();
    const card = await s.card();
    await s.kim.store.close();
    setFakeNodeConnected({ hub: s.hub, node: s.kim.node, connected: false });
    s.kim = {
      ...s.kim,
      ...(() => {
        const deps = restarted(s.kim.deps);
        return { deps, store: createPhotoStore(deps) };
      })(),
    };
    await s.kim.store.ready();
    expect((await s.kim.store.joinOffer(card.code, card.owner))[0]).toBeNull();
    expect((await s.admin.store.removeMember(s.folderId, s.keys.ben))[0]).toBeNull();
    setFakeNodeConnected({ hub: s.hub, node: s.kim.node, connected: true });
    const want = await s.adminShareKey();
    await until(async () => (await s.trip(s.kim))?.shareKey === want, 10_000);
    expect((await s.trip(s.kim))?.shareKey).toBe(want);
    await s.close();
  });

  it("stays invited across a restart of the Admin's phone", async () => {
    const s = await scene();
    expect((await s.admin.store.removeMember(s.folderId, s.keys.ben))[0]).toBeNull();
    await s.admin.store.close();
    const deps = restarted(s.admin.deps);
    const store = createPhotoStore(deps);
    (s.admin as { store: unknown }).store = store;
    await store.ready();
    const want = await joinsOnNewKey(s);
    expect((await s.trip(s.kim))?.shareKey).toBe(want);
    await s.close();
  });

  it("keeps the first card's code through a second Remove", async () => {
    const s = await scene();
    const card = await s.card();
    expect((await s.admin.store.removeMember(s.folderId, s.keys.ben))[0]).toBeNull();
    expect((await s.admin.store.removeMember(s.folderId, s.keys.nils))[0]).toBeNull();
    expect(s.record().heldAsks[identityOf(s.kim)]).toBe(card.code);
    const want = await joinsOnNewKey(s);
    expect((await s.trip(s.kim))?.shareKey).toBe(want);
    await s.close();
  });

  it("is not the only one who can use the old code: a stranger still hears it no longer works", async () => {
    const s = await scene();
    const card = await s.card();
    const stranger = phone(s.hub, "Carl");
    await stranger.store.ready();
    expect((await s.admin.store.removeMember(s.folderId, s.keys.ben))[0]).toBeNull();
    await stranger.store.ask({
      code: card.code,
      owner: identityOf(s.admin),
      albumName: "Trip",
      ownerName: "Anna",
    });
    const status = () =>
      (stranger.store.debugState() as { asks: { status: string }[] }).asks[0]?.status;
    await until(() => status() === "linkOff", 5_000);
    expect(status()).toBe("linkOff");
    await stranger.store.close();
    await s.close();
  });
});
