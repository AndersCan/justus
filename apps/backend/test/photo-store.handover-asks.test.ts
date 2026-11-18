/**
 * Requests made with the old Admin's link after the album was handed on:
 * the new Admin's phone tells the asker, the ask is sealed to it again, and
 * the request opens on the new Admin's phone. Phones share one fake hub.
 */
import { describe, it, expect } from "vite-plus/test";
import { mkdirSync } from "node:fs";
import { createPhotoStore } from "../src/photo-store.ts";
import { createFakeHub, addFakeNode, setFakeNodeConnected } from "./fakes/fake-world.ts";
import { FakeLoopbackServer, fakeStoreDeps, joinAsMember } from "./fakes/fake-store-deps.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function until(check: () => boolean | Promise<boolean>, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (!(await check()) && Date.now() < deadline) await sleep(25);
  expect(await check()).toBe(true);
}

function phone(hub: ReturnType<typeof createFakeHub>, deviceName: string) {
  const node = addFakeNode(hub);
  setFakeNodeConnected({ hub, node, connected: true });
  const deps = fakeStoreDeps({ hub, node, deviceName, server: new FakeLoopbackServer() });
  mkdirSync(deps.cacheDir, { recursive: true });
  return { deps, node, store: createPhotoStore(deps) };
}
type Phone = ReturnType<typeof phone>;

const identityOf = (p: Phone) => (p.store.debugState() as { identityDrive: string }).identityDrive;
const trip = async (p: Phone) => (await p.store.folders()).folders.find((f) => f.name === "Trip")!;

/** Ada's "Trip" with Ben as a Collaborator; Cy is outside the album. */
async function scene() {
  const hub = createFakeHub();
  const ada = phone(hub, "Ada");
  const ben = phone(hub, "Ben");
  const cy = phone(hub, "Cy");
  for (const p of [ada, ben, cy]) await p.store.ready();
  const created = await ada.store.createFolder("Trip");
  const folder = created[1]!.folder;
  const benKey = await joinAsMember(ada.store, folder.id, ben.store, folder.shareKey);
  await until(async () => (await ada.store.status()).members.length === 2);
  const handOver = async () => {
    expect((await ada.store.handOver(folder.id, benKey))[0]).toBeNull();
    await until(async () => (await trip(ben)).role === "creator");
  };
  const close = async () => {
    for (const p of [ada, ben, cy]) await p.store.close();
  };
  return { hub, ada, ben, cy, code: folder.invite!.code, folderId: folder.id, handOver, close };
}

describe("a request made with the old Admin's link", () => {
  it("reaches the new Admin, who lets the asker in", async () => {
    const s = await scene();
    await s.cy.store.ask({ code: s.code, owner: identityOf(s.ada) });
    await until(async () => (await s.ada.store.requests()).requests.length === 1);
    const [seenByAda] = (await s.ada.store.requests()).requests;
    await s.handOver();

    await until(async () => (await s.ben.store.requests()).requests.length === 1);
    const [onBen] = (await s.ben.store.requests()).requests;
    expect(onBen!.checkCode).toBe(seenByAda!.checkCode);
    expect((await s.cy.store.folders()).asks[0]).toMatchObject({
      owner: identityOf(s.ben),
      checkCode: onBen!.checkCode,
    });

    const benFolder = await trip(s.ben);
    expect((await s.ben.store.respond(benFolder.id, onBen!.requesterKey, true))[0]).toBeNull();
    await until(async () => (await s.cy.store.folders()).folders.some((f) => f.name === "Trip"));
    expect((await s.cy.store.folders()).asks).toEqual([]);
    await s.close();
  }, 40_000);

  it("made after the handover, with Ada's phone off, still reaches Ben", async () => {
    const s = await scene();
    await s.handOver();
    setFakeNodeConnected({ hub: s.hub, node: s.ada.node, connected: false });

    await s.cy.store.ask({ code: s.code, owner: identityOf(s.ada) });
    await until(async () => (await s.ben.store.requests()).requests.length === 1);
    const [ask] = (await s.cy.store.folders()).asks;
    expect(ask).toMatchObject({ owner: identityOf(s.ben), status: "waiting" });
    await until(async () => (await s.cy.store.folders()).asks[0]?.albumName === "Trip");
    expect((await s.cy.store.folders()).asks[0]!.ownerName).toBe("");
    await s.close();
  }, 40_000);

  it("is not re-pointed by a phone that is not the new Admin", async () => {
    const s = await scene();
    await s.cy.store.ask({ code: s.code, owner: identityOf(s.ada) });
    await until(async () => (await s.ada.store.requests()).requests.length === 1);
    await sleep(300);
    expect((await s.cy.store.folders()).asks[0]!.owner).toBe(identityOf(s.ada));
    await s.close();
  }, 20_000);
});
