/** An Admin who was handed the album removes someone, then restarts: the album stays on its new keys and the Admin row still names who handed it over. */
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
type Phone = ReturnType<typeof phone>;
const trip = async (p: Phone) => (await p.store.folders()).folders.find((f) => f.name === "Trip")!;

describe("a handed Admin who removes someone", () => {
  it("still has the bytes of its own photos after a restart", async () => {
    const hub = createFakeHub();
    const ada = phone(hub, "Ada");
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
    const benFolder = (await trip(ben)).id;
    const [adaAdd] = await ada.store.addBytes("a.jpg", new Uint8Array([9, 9, 9]), folderId);
    expect(adaAdd).toBeNull();
    const [addErr] = await ben.store.addBytes("b.jpg", new Uint8Array([1, 2, 3, 4]), benFolder);
    expect(addErr).toBeNull();
    expect((await ada.store.handOver(folderId, benKey))[0]).toBeNull();
    await until(async () => (await trip(ben)).role === "creator");
    await sleep(500);
    // Nobody else holds Ben's drive from here on (Ada left, Cy is removed, followers clear on follow).
    setFakeNodeConnected({ hub, node: ada.node, connected: false });
    setFakeNodeConnected({ hub, node: cy.node, connected: false });
    expect((await ben.store.removeMember(benFolder, cyKey))[0]).toBeNull();
    await sleep(1500);
    const [, adaNow] = await ben.deps.drives.open(shareKey, { timeoutMs: 2_000 });
    for await (const e of adaNow!.list("/photos", { wait: false })) {
      expect(await adaNow!.download(e.path, { timeoutMs: 300 }), "cleared at the Remove").not.toBe(
        "here",
      );
    }
    for (const p of [ada, cy]) await p.store.close();
    await ben.store.close();

    const rdeps = restarted(ben.deps);
    const back = createPhotoStore(rdeps);
    await back.ready();
    const listed = await back.list({ all: true });
    expect(listed.map((p) => p.name).sort()).toEqual(["a.jpg", "b.jpg"]);
    expect(listed.find((p) => p.name === "a.jpg")?.member.name).toBe("Ada");
    // Ada's photos moved to a drive of their own: her old drive no longer holds the bytes here.
    const [, adaOld] = await rdeps.drives.open(shareKey, { timeoutMs: 2_000 });
    for await (const e of adaOld!.list("/photos", { wait: false })) {
      expect(await adaOld!.download(e.path, { timeoutMs: 300 }), "Ada's old drive").not.toBe(
        "here",
      );
    }
    const fdKey = (back.debugState() as { folders: Array<{ folderDrive: { key: string } }> })
      .folders[0]!.folderDrive.key;
    expect(fdKey).toBe((await back.folders()).folders[0]!.shareKey);
    const admin = (await back.status()).members.find((m: { admin?: boolean }) => m.admin === true);
    expect(admin?.handedBy).toBe("Ada");
    const [, fd] = await rdeps.drives.open(fdKey, { timeoutMs: 2_000 });
    const got: string[] = [];
    for await (const e of fd!.list("/photos", { wait: false })) {
      got.push(await fd!.download(e.path, { timeoutMs: 500 }));
    }
    expect(got).toEqual(["here"]);
    await back.close();
  }, 60_000);
});
