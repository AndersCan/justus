/**
 * When letting the Viewer add photos fails, the handover is refused: the album
 * is never handed to someone who is still a Viewer.
 */
import { describe, it, expect } from "vite-plus/test";
import { createPhotoStore } from "../src/photo-store.ts";
import { createFakeHub, addFakeNode, setFakeNodeConnected } from "./fakes/fake-world.ts";
import { FakeLoopbackServer, fakeStoreDeps, joinAsMember } from "./fakes/fake-store-deps.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function until(check: () => boolean | Promise<boolean>, ms = 12_000) {
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

describe("a handover to a Viewer whose promotion fails", () => {
  it("is refused and leaves no handover on Ada's phone", async () => {
    const hub = createFakeHub();
    const ada = phone(hub, "Ada");
    let failMembers = false;
    const drives = ada.deps.drives;
    const real = drives.openOwn.bind(drives);
    drives.openOwn = (async (ns: string) => {
      const drive = await real(ns);
      return new Proxy(drive, {
        get(target, prop, receiver) {
          if (prop !== "put") return Reflect.get(target, prop, receiver);
          return (path: string, ...rest: unknown[]) =>
            failMembers && path === "/members.json"
              ? Promise.reject(new Error("disk full"))
              : (target.put as (...a: unknown[]) => unknown)(path, ...rest);
        },
      });
    }) as typeof drives.openOwn;
    const ben = phone(hub, "Ben");
    for (const p of [ada, ben]) await p.store.ready();
    const created = await ada.store.createFolder("Trip");
    const folderId = created[1]!.folder.id;
    const shareKey = created[1]!.folder.shareKey;
    const benKey = await joinAsMember(ada.store, folderId, ben.store, shareKey);
    await until(async () => {
      const m = (await ada.store.status()).members;
      return m.length === 2 && m.every((x: { identity?: string }) => x.identity !== undefined);
    });
    expect((await ada.store.makeViewer(folderId, benKey))[0]).toBeNull();

    failMembers = true;
    const [error] = await ada.store.handOver(folderId, benKey);
    expect(error).not.toBeNull();
    const row = (await ada.store.status()).members.find((x: { key?: string }) => x.key === benKey);
    expect(row).toMatchObject({ viewer: true });
    const debug = ada.store.debugState() as { folders: { handover?: unknown }[] };
    expect(debug.folders[0]!.handover).toBeUndefined();
    await ada.store.close();
    await ben.store.close();
  }, 30_000);
});
