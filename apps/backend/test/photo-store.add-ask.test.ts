/** A Viewer's ask to add photos reaches the Admin's phone over the Viewer's own drive. */
import { describe, it, expect } from "vite-plus/test";
import { createPhotoStore } from "../src/photo-store.ts";
import { createFakeHub, addFakeNode, setFakeNodeConnected } from "./fakes/fake-world.ts";
import {
  FakeLoopbackServer,
  fakeStoreDeps,
  joinAsMember,
  restarted,
} from "./fakes/fake-store-deps.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(done: () => boolean | Promise<boolean>, ms = 4_000): Promise<void> {
  for (let waited = 0; waited < ms && !(await done()); waited += 20) await sleep(20);
}

function phone(hub: ReturnType<typeof createFakeHub>, deviceName: string) {
  const node = addFakeNode(hub);
  setFakeNodeConnected({ hub, node, connected: true });
  const deps = fakeStoreDeps({ hub, node, deviceName, server: new FakeLoopbackServer() });
  return { deps, store: createPhotoStore(deps) };
}

type Person = { key: string; askedToAdd?: number };
const askOf = async (store: { status(): Promise<{ members: unknown[] }> }, key: string) =>
  ((await store.status()).members as Person[]).find((m) => m.key === key)?.askedToAdd;

describe("a Viewer asks to add photos", () => {
  it("reaches the Admin's phone, and still shows on the Viewer's phone after it restarts", async () => {
    const hub = createFakeHub();
    const ada = phone(hub, "Ada");
    const ben = phone(hub, "Ben");
    await ada.store.ready();
    await ben.store.ready();
    const created = (await ada.store.createFolder("Summer"))[1]!.folder;
    const benKey = await joinAsMember(ada.store, created.id, ben.store, created.shareKey);
    expect((await ada.store.makeViewer(created.id, benKey))[0]).toBeNull();
    await ada.store.setActive(created.id);
    const benFolder = (await ben.store.folders()).folders.find(
      (f) => f.shareKey === created.shareKey,
    )!;
    await ben.store.setActive(benFolder.id);

    const asked = await ben.store.askToAddPhotos(benFolder.id);
    expect(asked[0]).toBeNull();
    const askedAt = asked[1]!.askedAt;
    await sleep(5);
    expect((await ben.store.askToAddPhotos(benFolder.id))[1]!.askedAt).toBe(askedAt);
    await until(async () => (await askOf(ada.store, benKey)) !== undefined);
    expect(await askOf(ada.store, benKey)).toBe(askedAt);

    await ben.store.close();
    const back = createPhotoStore(restarted(ben.deps));
    await back.ready();
    expect(
      (await back.folders()).folders.find((f) => f.shareKey === created.shareKey)?.askedToAdd,
    ).toBe(askedAt);
    await back.close();
    await ada.store.close();
  }, 30_000);

  it("is refused for the Admin and never shown on a Collaborator's phone", async () => {
    const hub = createFakeHub();
    const ada = phone(hub, "Ada");
    const cy = phone(hub, "Cy");
    const ben = phone(hub, "Ben");
    for (const p of [ada, cy, ben]) await p.store.ready();
    const created = (await ada.store.createFolder("Summer"))[1]!.folder;
    await joinAsMember(ada.store, created.id, cy.store, created.shareKey);
    const benKey = await joinAsMember(ada.store, created.id, ben.store, created.shareKey);
    expect((await ada.store.makeViewer(created.id, benKey))[0]).toBeNull();
    await ada.store.setActive(created.id);
    const cyFolder = (await cy.store.folders()).folders.find(
      (f) => f.shareKey === created.shareKey,
    )!;
    await cy.store.setActive(cyFolder.id);
    const benFolder = (await ben.store.folders()).folders.find(
      (f) => f.shareKey === created.shareKey,
    )!;
    await ben.store.setActive(benFolder.id);

    expect((await ada.store.askToAddPhotos(created.id))[0]?.code).toBe(
      "justus.photos/already-enrolled",
    );
    expect((await ben.store.askToAddPhotos(benFolder.id))[0]).toBeNull();
    await until(async () => (await askOf(ada.store, benKey)) !== undefined);
    await sleep(800);
    expect(await askOf(ada.store, benKey)).toBeDefined();
    expect(await askOf(cy.store, benKey)).toBeUndefined();
    for (const p of [ada, cy, ben]) await p.store.close();
  }, 30_000);
});
