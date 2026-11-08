/**
 * A removed phone that deletes the album tells the Admin's phone, so the
 * person stops counting as a holder. Phones share one hub on the checked fakes.
 */
import { describe, it, expect } from "vite-plus/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPhotoStore } from "../src/photo-store.ts";
import { createFakeHub, addFakeNode, setFakeNodeConnected } from "./fakes/fake-world.ts";
import { FakeLoopbackServer, fakeStoreDeps, restarted } from "./fakes/fake-store-deps.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function until(done: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
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
type Phone = ReturnType<typeof phone>;

const identityOf = (s: Phone) => (s.store.debugState() as { identityDrive: string }).identityDrive;

const goneOf = (p: Phone) =>
  (JSON.parse(readFileSync(join(p.deps.storageDir, "justus.json"), "utf8")).gone ?? []) as {
    kind: string;
    at: number;
  }[];
const waiting = (p: Phone) => goneOf(p).filter((g) => g.kind === "waitingForAdminToHearYouDeleted");

async function restart(p: Phone) {
  await p.store.close();
  p.deps = restarted(p.deps);
  p.store = createPhotoStore(p.deps);
  await p.store.ready();
}

/** Anna's album; Nils and Cleo joined through the invite. Cleo opened the photo, then Anna removed her. */
async function removed() {
  const hub = createFakeHub();
  const anna = phone(hub, "Anna");
  const nils = phone(hub, "Nils");
  const cleo = phone(hub, "Cleo");
  for (const p of [anna, nils, cleo]) await p.store.ready();
  const created = await anna.store.createFolder("Trip");
  const { id: folderId, invite } = created[1]!.folder;
  const keys: Record<string, string> = {};
  for (const [name, who] of [
    ["nils", nils],
    ["cleo", cleo],
  ] as const) {
    await who.store.ask({
      code: invite!.code,
      owner: identityOf(anna),
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
    await until(async () => (await who.store.folders()).folders.length === 1);
  }
  const nilsId = (await nils.store.folders()).folders[0].id;
  const cleoId = (await cleo.store.folders()).folders[0].id;
  await anna.store.setActive(folderId);
  await cleo.store.setActive(cleoId);
  await nils.store.setActive(nilsId);
  await anna.store.addBytes("sunset.jpg", new Uint8Array([1, 2, 3, 4, 5]));
  await until(async () => (await cleo.store.list()).length === 1);
  const photo = (await cleo.store.list())[0];
  await cleo.server.getForTest(new URL(photo.url).pathname);
  await until(async () => (await anna.store.list())[0].holders!.others.length === 1);
  expect((await anna.store.removeMember(folderId, keys.cleo))[0]).toBeNull();
  await until(async () => (await cleo.store.folders()).folders[0]?.notice?.kind === "removed");
  await until(async () => (await anna.store.list())[0].holders!.former.length === 1);
  expect((await anna.store.list())[0].holders!.former).toHaveLength(1);
  const holders = async (p: Phone) => (await p.store.list())[0].holders!;
  const close = async () => {
    for (const p of [anna, nils, cleo]) await p.store.close();
  };
  return { hub, anna, nils, cleo, folderId, nilsId, cleoId, keys, holders, close };
}

describe("a removed phone that deletes the album", () => {
  it("stops counting as a holder on the Admin's and others' phones", async () => {
    const s = await removed();
    expect((await s.cleo.store.leaveAlbum(s.cleoId))[0]).toBeNull();
    await until(async () => (await s.holders(s.anna)).left.length === 1);
    const anna = await s.holders(s.anna);
    expect(anna.former).toEqual([]);
    expect(anna.left).toHaveLength(1);
    await until(async () => (await s.holders(s.nils)).left.length === 1);
    expect((await s.holders(s.nils)).former).toEqual([]);
    await until(() => waiting(s.cleo).length === 0);
    expect(waiting(s.cleo)).toEqual([]);
    await s.close();
  }, 40_000);

  it("is heard after the Admin comes back", async () => {
    const s = await removed();
    await s.anna.store.close();
    setFakeNodeConnected({ hub: s.hub, node: s.anna.node, connected: false });
    expect((await s.cleo.store.leaveAlbum(s.cleoId))[0]).toBeNull();
    await until(() => waiting(s.cleo).length === 1);
    expect(waiting(s.cleo)).toHaveLength(1);
    setFakeNodeConnected({ hub: s.hub, node: s.anna.node, connected: true });
    await restart(s.anna);
    await until(async () => (await s.holders(s.anna)).left.length === 1);
    expect((await s.holders(s.anna)).former).toEqual([]);
    await until(() => waiting(s.cleo).length === 0);
    expect(waiting(s.cleo)).toEqual([]);
    await s.close();
  }, 40_000);

  it("keeps telling through its own restart", async () => {
    const s = await removed();
    await s.anna.store.close();
    setFakeNodeConnected({ hub: s.hub, node: s.anna.node, connected: false });
    expect((await s.cleo.store.leaveAlbum(s.cleoId))[0]).toBeNull();
    await until(() => waiting(s.cleo).length === 1);
    await restart(s.cleo);
    expect(waiting(s.cleo)).toHaveLength(1);
    setFakeNodeConnected({ hub: s.hub, node: s.anna.node, connected: true });
    await restart(s.anna);
    await until(async () => (await s.holders(s.anna)).left.length === 1);
    expect((await s.holders(s.anna)).former).toEqual([]);
    await s.close();
  }, 40_000);

  it("drops a record older than the hold at start and sends nothing", async () => {
    const s = await removed();
    await s.anna.store.close();
    setFakeNodeConnected({ hub: s.hub, node: s.anna.node, connected: false });
    expect((await s.cleo.store.leaveAlbum(s.cleoId))[0]).toBeNull();
    await until(() => waiting(s.cleo).length === 1);
    await s.cleo.store.close();
    const path = join(s.cleo.deps.storageDir, "justus.json");
    const saved = JSON.parse(readFileSync(path, "utf8"));
    for (const g of saved.gone) g.at = Date.now() - 91 * 24 * 60 * 60 * 1000;
    writeFileSync(path, JSON.stringify(saved));
    s.cleo.deps = restarted(s.cleo.deps);
    s.cleo.store = createPhotoStore(s.cleo.deps);
    await s.cleo.store.ready();
    expect(waiting(s.cleo)).toEqual([]);
    setFakeNodeConnected({ hub: s.hub, node: s.anna.node, connected: true });
    await restart(s.anna);
    await sleep(1_000);
    expect((await s.holders(s.anna)).former).toHaveLength(1);
    expect((await s.holders(s.anna)).left).toEqual([]);
    await s.close();
  }, 40_000);

  it("a person who is back in the album is not marked", async () => {
    const s = await removed();
    await s.anna.store.close();
    setFakeNodeConnected({ hub: s.hub, node: s.anna.node, connected: false });
    expect((await s.cleo.store.leaveAlbum(s.cleoId))[0]).toBeNull();
    await until(() => waiting(s.cleo).length === 1);
    setFakeNodeConnected({ hub: s.hub, node: s.anna.node, connected: true });
    await restart(s.anna);
    const created = (await s.anna.store.folders()).folders[0];
    await s.cleo.store.ask({
      code: created.invite!.code,
      owner: identityOf(s.anna),
      albumName: "Trip",
      ownerName: "Anna",
    });
    let requesterKey = "";
    await until(async () => {
      requesterKey = (await s.anna.store.requests()).requests[0]?.requesterKey ?? "";
      return requesterKey !== "";
    });
    expect((await s.anna.store.respond(s.folderId, requesterKey, true, "member"))[0]).toBeNull();
    await until(() => waiting(s.cleo).length === 0);
    expect(waiting(s.cleo)).toEqual([]);
    await until(async () => (await s.holders(s.anna)).left.length === 0);
    const anna = await s.holders(s.anna);
    expect(anna.left).toEqual([]);
    expect(anna.former).toEqual([]);
    await s.close();
  }, 40_000);

  it("a leave by someone still in the album sends nothing", async () => {
    const s = await removed();
    expect((await s.nils.store.leaveAlbum(s.nilsId))[0]).toBeNull();
    await sleep(500);
    expect(goneOf(s.nils).filter((g) => g.kind === "waitingForAdminToHearYouDeleted")).toEqual([]);
    expect((await s.holders(s.anna)).left).toEqual([]);
    await s.close();
  }, 40_000);
});
