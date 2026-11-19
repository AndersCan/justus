/**
 * Everyone but the Admin names the people she let in after them. Phones on the
 * checked fakes share one hub.
 */
import { describe, it, expect } from "vite-plus/test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPhotoStore } from "../src/photo-store.ts";
import { createFakeHub, addFakeNode, setFakeNodeConnected } from "./fakes/fake-world.ts";
import { FakeLoopbackServer, fakeStoreDeps, restarted } from "./fakes/fake-store-deps.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function until(done: () => boolean | Promise<boolean>, ms = 3_000): Promise<void> {
  for (let waited = 0; waited < ms && !(await done()); waited += 20) await sleep(20);
}

function phone(hub: ReturnType<typeof createFakeHub>, deviceName: string) {
  const node = addFakeNode(hub);
  setFakeNodeConnected({ hub, node, connected: true });
  const server = new FakeLoopbackServer();
  const deps = fakeStoreDeps({ hub, node, deviceName, server });
  return { deps, node, server, store: createPhotoStore(deps) };
}

type Phone = ReturnType<typeof phone>;

const identityOf = (s: Phone) => (s.store.debugState() as { identityDrive: string }).identityDrive;

/** Anna's album; `who` asks through the invite and Anna lets them in. */
async function letIn(
  admin: Phone,
  folderId: string,
  code: string,
  who: Phone,
  role: "member" | "reader",
) {
  await who.store.ask({ code, owner: identityOf(admin) });
  let requesterKey = "";
  await until(async () => {
    requesterKey = (await admin.store.requests()).requests[0]?.requesterKey ?? "";
    return requesterKey !== "";
  });
  expect((await admin.store.respond(folderId, requesterKey, true, role))[0]).toBeNull();
  await until(async () => (await who.store.folders()).folders.length > 0);
}

async function trip() {
  const hub = createFakeHub();
  const anna = phone(hub, "Anna");
  const nils = phone(hub, "Nils");
  const vera = phone(hub, "Vera");
  const ben = phone(hub, "Ben");
  for (const p of [anna, nils, vera, ben]) await p.store.ready();
  const { id: folderId, invite } = (await anna.store.createFolder("Trip"))[1]!.folder;
  const code = invite!.code;
  return { hub, anna, nils, vera, ben, folderId, code, all: [anna, nils, vera, ben] };
}

function savedRecord(phoneOf: Phone, folderId: string): { joinedUpTo?: number } {
  const saved = JSON.parse(readFileSync(join(phoneOf.deps.storageDir, "justus.json"), "utf8"));
  return saved.folders.find((f: { id: string }) => f.id === folderId);
}

const joined = async (p: Phone) => (await p.store.folders()).folders[0]?.whoJoined;
const waitFor = (p: Phone, names: string[]) =>
  until(async () => JSON.stringify(await joined(p)) === JSON.stringify(names));

describe("who joined after me", () => {
  it("each phone names only the people let in after it", async () => {
    const s = await trip();
    await letIn(s.anna, s.folderId, s.code, s.nils, "member");
    await letIn(s.anna, s.folderId, s.code, s.vera, "reader");
    await letIn(s.anna, s.folderId, s.code, s.ben, "member");
    await waitFor(s.nils, ["Vera", "Ben"]);
    expect(await joined(s.nils)).toEqual(["Vera", "Ben"]);
    expect(await joined(s.ben)).toBeUndefined();
    expect(await joined(s.anna)).toBeUndefined();
    expect(savedRecord(s.anna, s.folderId).joinedUpTo, "the Admin names no one").toBeUndefined();
    for (const p of s.all) await p.store.close();
  });

  it("a phone that was off names who was let in meanwhile", async () => {
    const s = await trip();
    await letIn(s.anna, s.folderId, s.code, s.nils, "member");
    const nilsId = (await s.nils.store.folders()).folders[0]!.id;
    expect(savedRecord(s.nils, nilsId).joinedUpTo, "a fresh join starts at 0").toBe(0);
    setFakeNodeConnected({ hub: s.hub, node: s.nils.node, connected: false });
    await letIn(s.anna, s.folderId, s.code, s.ben, "member");
    setFakeNodeConnected({ hub: s.hub, node: s.nils.node, connected: true });
    await waitFor(s.nils, ["Ben"]);
    expect(await joined(s.nils)).toEqual(["Ben"]);
    for (const p of s.all) await p.store.close();
  });

  it("Dismiss clears the line and a restart neither brings it back nor names anyone again", async () => {
    const s = await trip();
    await letIn(s.anna, s.folderId, s.code, s.nils, "member");
    await letIn(s.anna, s.folderId, s.code, s.ben, "member");
    await waitFor(s.nils, ["Ben"]);
    const id = (await s.nils.store.folders()).folders[0]!.id;
    expect((await s.nils.store.dismissWhoJoined(id))[0]).toBeNull();
    expect(await joined(s.nils)).toBeUndefined();
    await s.nils.store.close();
    const again = createPhotoStore(restarted(s.nils.deps));
    await again.ready();
    await sleep(300);
    expect((await again.folders()).folders[0]?.whoJoined).toBeUndefined();
    await again.close();
    for (const p of [s.anna, s.vera, s.ben]) await p.store.close();
  });

  it("an album saved without a usable joinedUpTo starts silently", async () => {
    const s = await trip();
    await letIn(s.anna, s.folderId, s.code, s.nils, "member");
    await letIn(s.anna, s.folderId, s.code, s.ben, "member");
    await waitFor(s.nils, ["Ben"]);
    await s.nils.store.close();
    const file = join(s.nils.deps.storageDir, "justus.json");
    const saved = JSON.parse(readFileSync(file, "utf8"));
    for (const f of saved.folders) {
      f.joinedUpTo = -1;
      delete f.whoJoined;
    }
    writeFileSync(file, JSON.stringify(saved));
    const again = createPhotoStore(restarted(s.nils.deps));
    await again.ready();
    await sleep(300);
    expect((await again.folders()).folders[0]?.whoJoined).toBeUndefined();
    await again.close();
    for (const p of [s.anna, s.vera, s.ben]) await p.store.close();
  });
});
