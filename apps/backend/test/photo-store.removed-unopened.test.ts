/**
 * A removed phone lists only the photos it holds in full: the ones it opened and
 * the ones it added. Phones share one hub on the checked fakes.
 */
import { describe, it, expect } from "vite-plus/test";
import { mkdirSync } from "node:fs";
import { createPhotoStore } from "../src/photo-store.ts";
import { createFakeHub, addFakeNode, setFakeNodeConnected } from "./fakes/fake-world.ts";
import { FakeLoopbackServer, fakeStoreDeps } from "./fakes/fake-store-deps.ts";

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

describe("a removed phone", () => {
  it("lists and serves only the photos it holds in full", async () => {
    const hub = createFakeHub();
    const anna = phone(hub, "Anna");
    const cleo = phone(hub, "Cleo");
    for (const p of [anna, cleo]) await p.store.ready();
    const created = await anna.store.createFolder("Trip");
    const { id: folderId, invite } = created[1]!.folder;
    await cleo.store.ask({ code: invite!.code, owner: identityOf(anna) });
    let requesterKey = "";
    await until(async () => {
      requesterKey = (await anna.store.requests()).requests[0]?.requesterKey ?? "";
      return requesterKey !== "";
    });
    expect((await anna.store.respond(folderId, requesterKey, true, "member"))[0]).toBeNull();
    await until(async () => (await cleo.store.folders()).folders.length === 1);
    const cleoId = (await cleo.store.folders()).folders[0].id;
    await anna.store.setActive(folderId);
    await cleo.store.setActive(cleoId);
    await anna.store.addBytes("sunset.jpg", new Uint8Array([1, 2, 3, 4, 5]));
    await anna.store.addBytes("dog.jpg", new Uint8Array([6, 7, 8, 9, 10]));
    await until(async () => (await cleo.store.list()).length === 2);
    const before = await cleo.store.list();
    const sunset = before.find((p) => p.name === "sunset.jpg")!;
    const dog = before.find((p) => p.name === "dog.jpg")!;
    await cleo.server.getForTest(new URL(sunset.url).pathname);
    await until(
      async () =>
        (await anna.store.list()).find((p) => p.name === "sunset.jpg")!.holders!.others.length ===
        1,
    );
    await cleo.store.addBytes("cleo.jpg", new Uint8Array([11, 12, 13]));
    expect((await anna.store.removeMember(folderId, requesterKey))[0]).toBeNull();
    await until(async () => (await cleo.store.folders()).folders[0]?.notice?.kind === "removed");
    await until(async () => (await cleo.store.list()).length === 2);
    const names = (await cleo.store.list()).map((p) => p.name).sort();
    expect(names).toEqual(["cleo.jpg", "sunset.jpg"]);
    const opened = (await cleo.store.list()).find((p) => p.name === "sunset.jpg")!;
    expect((await cleo.server.getForTest(new URL(opened.url).pathname)).status).toBe(200);
    expect((await cleo.server.getForTest(new URL(dog.url).pathname)).status).toBe(404);
    for (const p of [anna, cleo]) await p.store.close();
  }, 40_000);
});
