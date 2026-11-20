/** An Admin whose phone was off through the handover and a Remove still leaves the album when it comes back. */
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
const trip = async (p: Phone) => (await p.store.folders()).folders.find((f) => f.name === "Trip");

describe("an Admin whose phone was off through the handover and a Remove", () => {
  it("leaves the album when it comes back, holding none of its photos", async () => {
    const hub = createFakeHub();
    const adaLogs: Ev[] = [];
    const ada = phone(hub, "Ada", adaLogs);
    const ben = phone(hub, "Ben");
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
    const benFolder = (await trip(ben))!.id;
    await until(async () => (await ben.store.list({ all: true })).some((p) => p.name === "a.jpg"));
    expect(
      (await ben.store.addBytes("b.jpg", new Uint8Array([1, 2, 3, 4]), benFolder))[0],
    ).toBeNull();
    await until(async () => (await ada.store.list({ all: true })).length === 2);

    // Hold Ben's note until Ada's phone is off.
    let holdNote = true;
    const network = ben.deps.network;
    const sendAnswer = network.sendAnswer.bind(network);
    network.sendAnswer = ((conn: number, msg: { kind: string }) =>
      holdNote && msg.kind === "handoverDone"
        ? Promise.resolve(false)
        : sendAnswer(conn, msg as never)) as typeof network.sendAnswer;
    expect((await ada.store.handOver(folderId, benKey))[0]).toBeNull();
    await until(async () => (await trip(ben))?.role === "creator");
    await until(() => adaLogs.some((e) => e.event === "handover.written"));
    await sleep(500);

    await ada.store.close();
    setFakeNodeConnected({ hub, node: ada.node, connected: false });
    holdNote = false;
    expect((await ben.store.removeMember(benFolder, cyKey))[0]).toBeNull();
    await until(async () => (await trip(ben))?.shareKey !== shareKey);

    setFakeNodeConnected({ hub, node: ada.node, connected: true });
    const back = createPhotoStore(restarted(ada.deps));
    await back.ready();
    await until(async () => (await back.folders()).folders.every((f) => f.name !== "Trip"));
    expect(adaLogs.some((e) => e.event === "handover.done")).toBe(true);
    expect((await ben.store.list({ all: true })).map((p) => p.name).sort()).toEqual([
      "a.jpg",
      "b.jpg",
    ]);

    // The fake serves exactly what a phone stores: Ada's phone holds no photo bytes.
    const held: string[] = [];
    for (const [key, replica] of ada.node.replicas) {
      if (key === ada.node.ownKeys.get("")) continue;
      for (const [path, file] of replica.files) {
        if (/^\/(photos|thumbs)\//.test(path) && file.clearedSize === undefined) held.push(path);
      }
    }
    expect(held).toEqual([]);
    for (const s of [back, ben.store, cy.store]) await s.close();
  }, 60_000);
});
