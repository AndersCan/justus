/** Repro: an accepted ask's `adminDrive` must survive a restart before the join finishes. */
import { describe, it, expect } from "vite-plus/test";
import { readFileSync } from "node:fs";
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

/** Cy's copy of Ada's drive never shows `/admin.json`; opens of `hang` never finish. */
function staleAda(deps: ReturnType<typeof fakeStoreDeps>, adaKey: string, hang?: string) {
  const open = deps.drives.open.bind(deps.drives);
  deps.drives.open = (async (key: string, ...rest: unknown[]) => {
    if (key === hang) return new Promise(() => {});
    const res = await (open as (...a: unknown[]) => Promise<[unknown, any]>)(key, ...rest);
    if (key === adaKey && res[1] && !res[1].__stale) {
      const d = res[1];
      const readSmall = d.readSmall.bind(d);
      d.readSmall = async (...a: unknown[]) => (a[0] === "/admin.json" ? null : readSmall(...a));
      d.__stale = true;
    }
    return res;
  }) as typeof deps.drives.open;
}

describe("an accepted asker restarts before the join finishes", () => {
  it("still reads the new Admin's lists", async () => {
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
    expect((await ada.store.handOver(folder.id, benKey))[0]).toBeNull();
    await until(async () => (await trip(ben))?.role === "creator");
    setFakeNodeConnected({ hub, node: ada.node, connected: false });
    // Cy's join stalls opening Ben's drive, as when the phone is killed mid-join.
    staleAda(cy.deps, folder.shareKey, benKey);
    await until(async () => (await ben.store.requests()).requests.length === 1);
    const [request] = (await ben.store.requests()).requests;
    expect(
      (await ben.store.respond((await trip(ben))!.id, request!.requesterKey, true))[0],
    ).toBeNull();
    const file = join(cy.deps.storageDir, "justus.json");
    const savedAsk = () => {
      const saved = JSON.parse(readFileSync(file, "utf8"));
      return ((saved.asks ?? saved.state?.asks) as Array<Record<string, unknown>>)[0];
    };
    await until(() => savedAsk()?.status === "accepted");
    expect(savedAsk()!.adminDrive).toBe(benKey);
    await cy.store.close();
    const deps2 = restarted(cy.deps);
    staleAda(deps2, folder.shareKey);
    const cy2 = { ...cy, deps: deps2, store: createPhotoStore(deps2) };
    await cy2.store.ready();
    await until(async () => (await trip(cy2))?.role === "member");
    for (const p of [ada, ben, cy2]) await p.store.close();
  }, 40_000);

  it("keeps reading the new Admin's lists after a restart once joined", async () => {
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
    staleAda(cy.deps, folder.shareKey);
    expect((await ada.store.handOver(folder.id, benKey))[0]).toBeNull();
    await until(async () => (await trip(ben))?.role === "creator");
    setFakeNodeConnected({ hub, node: ada.node, connected: false });
    await until(async () => (await ben.store.requests()).requests.length === 1);
    const [request] = (await ben.store.requests()).requests;
    expect(
      (await ben.store.respond((await trip(ben))!.id, request!.requesterKey, true))[0],
    ).toBeNull();
    await until(async () => (await trip(cy))?.role === "member");
    await cy.store.close();
    const deps2 = restarted(cy.deps);
    staleAda(deps2, folder.shareKey);
    const cy2 = { ...cy, deps: deps2, store: createPhotoStore(deps2) };
    await cy2.store.ready();
    await sleep(500);
    await until(async () => (await trip(cy2))?.role === "member");
    const names = async () =>
      (await cy2.store.status()).members.map((m: { name: string }) => m.name).toSorted();
    await until(async () => (await names()).join() === "Ben,Cy");
    for (const p of [ada, ben, cy2]) await p.store.close();
  }, 40_000);

  it("ends on the latest Admin when the answer names an earlier one", async () => {
    const hub = createFakeHub();
    const ada = phone(hub, "Ada");
    const ben = phone(hub, "Ben");
    const cy = phone(hub, "Cy");
    const dee = phone(hub, "Dee");
    for (const p of [ada, ben, cy, dee]) await p.store.ready();
    const folder = (await ada.store.createFolder("Trip"))[1]!.folder;
    const benKey = await joinAsMember(ada.store, folder.id, ben.store, folder.shareKey);
    await until(async () => (await ada.store.status()).members.length === 2);
    await cy.store.ask({ code: folder.invite!.code, owner: identityOf(ada) });
    await until(async () => (await ada.store.requests()).requests.length === 1);
    await until(async () => (await cy.store.folders()).asks.length === 1);
    expect((await ada.store.handOver(folder.id, benKey))[0]).toBeNull();
    await until(async () => (await trip(ben))?.role === "creator");
    const deeKey = await joinAsMember(ben.store, (await trip(ben))!.id, dee.store, folder.shareKey);
    // Cy's join waits until Ben has handed on to Dee, so the answer names Ben but Ada's chain ends at Dee.
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const open = cy.deps.drives.open.bind(cy.deps.drives);
    cy.deps.drives.open = (async (key: string, ...rest: unknown[]) => {
      if (key === benKey) await gate;
      return (open as (...a: unknown[]) => Promise<unknown>)(key, ...rest);
    }) as typeof cy.deps.drives.open;
    await until(async () => (await ben.store.requests()).requests.length === 1);
    const [request] = (await ben.store.requests()).requests;
    expect(
      (await ben.store.respond((await trip(ben))!.id, request!.requesterKey, true))[0],
    ).toBeNull();
    expect((await ben.store.handOver((await trip(ben))!.id, deeKey))[0]).toBeNull();
    await until(async () => (await trip(dee))?.role === "creator");
    release();
    await until(async () => (await trip(cy))?.role === "member");
    const names = async () =>
      (await cy.store.status()).members.map((m: { name: string }) => m.name).toSorted();
    await until(async () => (await names()).includes("Dee"));
    const chain = () =>
      (cy.store.debugState() as { folders: Array<{ adminChain?: string[] }> }).folders[0]!
        .adminChain;
    expect(chain()).toEqual([folder.shareKey, benKey, deeKey]);
    for (const p of [ada, ben, cy, dee]) await p.store.close();
  }, 40_000);
});
