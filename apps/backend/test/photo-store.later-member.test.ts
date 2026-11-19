/**
 * A phone already in an album opens the photos of someone let in after it,
 * whether it was on or off at the time, and tries again when a phone connects.
 */
import { describe, it, expect } from "vite-plus/test";
import { createPhotoStore } from "../src/photo-store.ts";
import { createFakeHub, addFakeNode, setFakeNodeConnected } from "./fakes/fake-world.ts";
import { FakeLoopbackServer, fakeStoreDeps, restarted } from "./fakes/fake-store-deps.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function until(done: () => boolean | Promise<boolean>, ms = 5_000): Promise<void> {
  for (let waited = 0; waited < ms && !(await done()); waited += 20) await sleep(20);
}

function phone(hub: ReturnType<typeof createFakeHub>, deviceName: string, openMs?: number) {
  const node = addFakeNode(hub);
  setFakeNodeConnected({ hub, node, connected: true });
  const server = new FakeLoopbackServer();
  const deps = fakeStoreDeps({ hub, node, deviceName, server, driveOpenTimeoutMs: openMs });
  return { deps, node, server, store: createPhotoStore(deps) };
}

type Phone = ReturnType<typeof phone>;

const identityOf = (s: Phone) => (s.store.debugState() as { identityDrive: string }).identityDrive;

async function letIn(admin: Phone, folderId: string, code: string, who: Phone) {
  await who.store.ask({ code, owner: identityOf(admin) });
  let requesterKey = "";
  await until(async () => {
    requesterKey = (await admin.store.requests()).requests[0]?.requesterKey ?? "";
    return requesterKey !== "";
  });
  expect((await admin.store.respond(folderId, requesterKey, true, "member"))[0]).toBeNull();
  await until(async () => (await who.store.folders()).folders.length > 0);
}

async function setup(offline = new Set<string>(), openMs?: number) {
  const hub = createFakeHub({ readyDelayMs: (k) => (offline.has(k) ? Infinity : 0) });
  const anna = phone(hub, "Anna", openMs);
  const nils = phone(hub, "Nils", openMs);
  const ben = phone(hub, "Ben", openMs);
  for (const p of [anna, nils, ben]) await p.store.ready();
  const { id: folderId, invite } = (await anna.store.createFolder("Trip"))[1]!.folder;
  await letIn(anna, folderId, invite!.code, nils);
  return { hub, anna, nils, ben, folderId, code: invite!.code };
}

const names = async (p: Phone) => (await p.store.list({ all: true })).map((x) => x.name);
const has = async (p: Phone, name: string) => (await names(p)).includes(name);

async function benAdds(s: Awaited<ReturnType<typeof setup>>) {
  await letIn(s.anna, s.folderId, s.code, s.ben);
  const benFolder = (await s.ben.store.folders()).folders[0]!.id;
  expect(
    (await s.ben.store.addBytes("ben.jpg", new Uint8Array([1, 2, 3, 4]), benFolder))[0],
  ).toBeNull();
}

describe("a phone follows someone let in after it", () => {
  it("a Collaborator gets photos from someone let in after them, with no restart", async () => {
    const s = await setup();
    await benAdds(s);
    await until(() => has(s.nils, "ben.jpg"));
    expect(await has(s.nils, "ben.jpg")).toBe(true);
    for (const p of [s.anna, s.nils, s.ben]) await p.store.close();
  });

  it("a phone that was off gets them once it is back", async () => {
    const s = await setup();
    setFakeNodeConnected({ hub: s.hub, node: s.nils.node, connected: false });
    await benAdds(s);
    setFakeNodeConnected({ hub: s.hub, node: s.nils.node, connected: true });
    await until(() => has(s.nils, "ben.jpg"));
    expect(await has(s.nils, "ben.jpg")).toBe(true);
    for (const p of [s.anna, s.nils, s.ben]) await p.store.close();
  });

  it("a drive that could not be opened is opened once that phone connects", async () => {
    const offline = new Set<string>();
    const s = await setup(offline, 300);
    setFakeNodeConnected({ hub: s.hub, node: s.nils.node, connected: false });
    await benAdds(s);
    const benKey = (await s.anna.store.list({ all: true })).find((x) => x.name === "ben.jpg")!
      .member.key;
    offline.add(benKey);
    await s.ben.store.close();
    setFakeNodeConnected({ hub: s.hub, node: s.nils.node, connected: true });
    await s.anna.store.addBytes("anna.jpg", new Uint8Array([9, 9, 9]), s.folderId);
    await sleep(1_500);
    expect(await has(s.nils, "ben.jpg")).toBe(false);
    offline.delete(benKey);
    const ben2 = createPhotoStore(restarted(s.ben.deps));
    await ben2.ready();
    await until(() => has(s.nils, "ben.jpg"));
    expect(await has(s.nils, "ben.jpg")).toBe(true);
    for (const p of [s.anna, s.nils]) await p.store.close();
    await ben2.close();
  }, 15_000);
});
