/**
 * An asker who asked before the handover and is accepted by the new Admin
 * while the old Admin's phone is off reads the new Admin's lists.
 */
import { describe, it, expect } from "vite-plus/test";
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
  return { deps, node, store: createPhotoStore(deps) };
}
type Phone = ReturnType<typeof phone>;

const identityOf = (p: Phone) => (p.store.debugState() as { identityDrive: string }).identityDrive;
const trip = async (p: Phone) => (await p.store.folders()).folders.find((f) => f.name === "Trip");

describe("an asker the new Admin accepts while the old Admin's phone is off", () => {
  it("reads the new Admin's lists", async () => {
    const hub = createFakeHub();
    const ada = phone(hub, "Ada");
    const ben = phone(hub, "Ben");
    const cy = phone(hub, "Cy");
    for (const p of [ada, ben, cy]) await p.store.ready();
    const folder = (await ada.store.createFolder("Trip"))[1]!.folder;
    const benKey = await joinAsMember(ada.store, folder.id, ben.store, folder.shareKey);
    await until(async () => (await ada.store.status()).members.length === 2);

    await cy.store.ask({ code: folder.invite!.code, owner: identityOf(ada) });
    await until(async () => (await ada.store.requests()).requests.length === 1);
    await until(async () => (await cy.store.folders()).asks.length === 1);

    // Cy's copy of Ada's drive never gets `/admin.json`.
    const [openErr, adaDrive] = await cy.deps.drives.open(folder.shareKey, { timeoutMs: 2_000 });
    expect(openErr).toBeNull();
    const readSmall = adaDrive!.readSmall.bind(adaDrive!) as (
      ...a: unknown[]
    ) => Promise<string | null>;
    adaDrive!.readSmall = (async (...args: unknown[]) =>
      args[0] === "/admin.json" ? null : readSmall(...args)) as typeof adaDrive.readSmall;

    expect((await ada.store.handOver(folder.id, benKey))[0]).toBeNull();
    await until(async () => (await trip(ben))?.role === "creator");
    setFakeNodeConnected({ hub, node: ada.node, connected: false });

    await until(async () => (await ben.store.requests()).requests.length === 1);
    const [request] = (await ben.store.requests()).requests;
    expect(
      (await ben.store.respond((await trip(ben))!.id, request!.requesterKey, true))[0],
    ).toBeNull();

    await until(async () => (await trip(cy))?.role === "member");
    const names = async () =>
      (await cy.store.status()).members.map((m: { name: string }) => m.name).toSorted();
    await until(async () => (await names()).join() === "Ben,Cy");
    for (const p of [ada, ben, cy]) await p.store.close();
  }, 40_000);
});
