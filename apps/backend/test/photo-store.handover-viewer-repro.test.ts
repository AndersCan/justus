/**
 * A refused handover to a Viewer changes nothing: every refusal runs before
 * the Viewer is let add photos.
 */
import { describe, it, expect } from "vite-plus/test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPhotoStore, PhotoError } from "../src/photo-store.ts";
import { createFakeHub, addFakeNode, setFakeNodeConnected } from "./fakes/fake-world.ts";
import {
  FakeLoopbackServer,
  fakeStoreDeps,
  joinAsMember,
  restarted,
} from "./fakes/fake-store-deps.ts";

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

describe("a refused handover to a Viewer", () => {
  it("leaves the Viewer a Viewer while a Remove is still moving people", async () => {
    const hub = createFakeHub();
    const ada = phone(hub, "Ada");
    const ben = phone(hub, "Ben");
    const cy = phone(hub, "Cy");
    for (const p of [ada, ben, cy]) await p.store.ready();
    const created = await ada.store.createFolder("Trip");
    const folderId = created[1]!.folder.id;
    const shareKey = created[1]!.folder.shareKey;
    const benKey = await joinAsMember(ada.store, folderId, ben.store, shareKey);
    const cyKey = await joinAsMember(ada.store, folderId, cy.store, shareKey);
    await until(async () => {
      const m = (await ada.store.status()).members;
      return m.length === 3 && m.every((x: { identity?: string }) => x.identity !== undefined);
    });
    expect((await ada.store.makeViewer(folderId, benKey))[0]).toBeNull();

    await ada.store.close();
    const file = join(ada.deps.storageDir, "justus.json");
    const saved = JSON.parse(readFileSync(file, "utf8"));
    saved.folders[0].moveOwed = [cyKey];
    writeFileSync(file, JSON.stringify(saved));
    const reopened = createPhotoStore(restarted(ada.deps));
    await reopened.ready();
    const before = (await reopened.status()).members.find(
      (x: { key?: string }) => x.key === benKey,
    );
    expect(before).toMatchObject({ viewer: true });

    const [error] = await reopened.handOver(folderId, benKey);
    expect(error?.code).toBe(PhotoError.HANDOVER_MOVE_OPEN);
    const benRow = (await reopened.status()).members.find(
      (x: { key?: string }) => x.key === benKey,
    );
    expect(benRow).toMatchObject({ viewer: true });
    await reopened.close();
    await ben.store.close();
    await cy.store.close();
  }, 30_000);
});
