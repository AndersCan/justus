/** A handed Admin who removes someone clears his pre-Remove drive, at the Remove and, when cut short, at the next start. */
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vite-plus/test";
import { createPhotoStore } from "../src/photo-store.ts";
import { createFakeHub, addFakeNode, setFakeNodeConnected } from "./fakes/fake-world.ts";
import {
  FakeLoopbackServer,
  fakeStoreDeps,
  joinAsMember,
  restarted,
} from "./fakes/fake-store-deps.ts";

type Ev = { event: string; fields: Record<string, unknown> };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(check: () => boolean | Promise<boolean>, ms = 12_000) {
  const deadline = Date.now() + ms;
  while (!(await check()) && Date.now() < deadline) await sleep(25);
  expect(await check()).toBe(true);
}
function phone(hub: ReturnType<typeof createFakeHub>, deviceName: string, logs: Ev[] = []) {
  const node = addFakeNode(hub);
  setFakeNodeConnected({ hub, node, connected: true });
  const deps = fakeStoreDeps({ hub, node, deviceName, server: new FakeLoopbackServer() });
  deps.log = (e: Ev) => logs.push(e);
  return { deps, node, store: createPhotoStore(deps) };
}
type Phone = ReturnType<typeof phone>;
const trip = async (p: Phone) => (await p.store.folders()).folders.find((f) => f.name === "Trip")!;
const fdKeyOf = (s: Phone["store"]) =>
  (s.debugState() as { folders: Array<{ folderDrive: { key: string } }> }).folders[0]!.folderDrive
    .key;

async function handedThenRemove(benLogs: Ev[]) {
  const hub = createFakeHub();
  const ada = phone(hub, "Ada");
  const ben = phone(hub, "Ben", benLogs);
  const cy = phone(hub, "Cy");
  for (const p of [ada, ben, cy]) await p.store.ready();
  const created = await ada.store.createFolder("Trip");
  const { id: folderId, shareKey } = created[1]!.folder;
  const benKey = await joinAsMember(ada.store, folderId, ben.store, shareKey);
  const cyKey = await joinAsMember(ada.store, folderId, cy.store, shareKey);
  await until(async () => {
    const m = (await ada.store.status()).members;
    return m.length === 3 && m.every((x: { identity?: string }) => x.identity !== undefined);
  });
  expect((await ada.store.addBytes("a.jpg", new Uint8Array([9, 8, 7]), folderId))[0]).toBeNull();
  const benFolder = (await trip(ben)).id;
  await until(async () => (await ben.store.list({ all: true })).some((p) => p.name === "a.jpg"));
  expect(
    (await ben.store.addBytes("b.jpg", new Uint8Array([1, 2, 3, 4]), benFolder))[0],
  ).toBeNull();
  expect((await ada.store.handOver(folderId, benKey))[0]).toBeNull();
  await until(async () => (await trip(ben)).role === "creator");
  await sleep(500);
  const benOld = fdKeyOf(ben.store);
  setFakeNodeConnected({ hub, node: ada.node, connected: false });
  setFakeNodeConnected({ hub, node: cy.node, connected: false });
  return { ada, ben, cy, benFolder, cyKey, benOld, adaKey: shareKey };
}

describe("a handed Admin who removes someone", () => {
  it("clears his pre-Remove drive at the Remove", async () => {
    const logs: Ev[] = [];
    const s = await handedThenRemove(logs);
    expect((await s.ben.store.removeMember(s.benFolder, s.cyKey))[0]).toBeNull();
    await until(() =>
      logs.some(
        (e) =>
          e.event === "move.cleared" &&
          e.fields.why === "moved" &&
          e.fields.drive === s.benOld.slice(0, 8),
      ),
    );
    for (const p of [s.ada, s.cy, s.ben]) await p.store.close();
  }, 60_000);

  it("keeps his pre-Remove drive in pastKeys, so a start after a cut-short clear still clears it", async () => {
    const logs: Ev[] = [];
    const s = await handedThenRemove(logs);
    expect((await s.ben.store.removeMember(s.benFolder, s.cyKey))[0]).toBeNull();
    // Closed before the Remove's clear can finish.
    for (const p of [s.ada, s.cy, s.ben]) await p.store.close();
    const rdeps = restarted(s.ben.deps);
    const saved = JSON.parse(fs.readFileSync(path.join(rdeps.storageDir, "justus.json"), "utf8"));
    expect(saved.folders[0].pastKeys).toContain(s.benOld);
    const back = createPhotoStore(rdeps);
    await back.ready();
    await sleep(1500);
    const [, old] = await rdeps.drives.open(s.benOld, { timeoutMs: 2_000 });
    const got: string[] = [];
    for await (const e of old!.list("/photos", { wait: false })) {
      got.push(await old!.download(e.path, { timeoutMs: 500 }));
    }
    expect(got).not.toContain("here");
    await back.close();
  }, 60_000);

  it("does not name Ada as holding her photos after the Remove", async () => {
    const s = await handedThenRemove([]);
    expect((await s.ben.store.removeMember(s.benFolder, s.cyKey))[0]).toBeNull();
    await sleep(1500);
    const a = (await s.ben.store.list({ all: true })).find((p) => p.name === "a.jpg")!;
    expect(a.member?.name).toBe("Ada");
    expect(a.holders!.others.map((m: { key: string }) => m.key)).not.toContain(s.adaKey);
    for (const p of [s.ada, s.cy, s.ben]) await p.store.close();
  }, 60_000);
});
