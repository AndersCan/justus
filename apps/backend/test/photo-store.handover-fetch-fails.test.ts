/**
 * Ben's phone cannot fetch one of Ada's photos (her peer drops, or his storage
 * is full): it does not answer "ready", so Ada's phone never writes the handover.
 */
import { describe, it, expect } from "vite-plus/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPhotoStore } from "../src/photo-store.ts";
import type { P2pEvent } from "../src/p2p-log.ts";
import type { Drive } from "../src/ports/drive-store.ts";
import { createFakeHub, addFakeNode, setFakeNodeConnected } from "./fakes/fake-world.ts";
import { FakeLoopbackServer, fakeStoreDeps, joinAsMember } from "./fakes/fake-store-deps.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(check: () => boolean | Promise<boolean>, ms = 12_000) {
  const deadline = Date.now() + ms;
  while (!(await check()) && Date.now() < deadline) await sleep(25);
  expect(await check()).toBe(true);
}

describe("a photo Ben's phone cannot fetch", () => {
  it("keeps Ada's phone from writing the handover", async () => {
    const hub = createFakeHub();
    const adaEvents: P2pEvent[] = [];
    const benEvents: P2pEvent[] = [];
    const phone = (deviceName: string, log: (e: P2pEvent) => void) => {
      const node = addFakeNode(hub);
      setFakeNodeConnected({ hub, node, connected: true });
      return fakeStoreDeps({ hub, node, deviceName, server: new FakeLoopbackServer(), log });
    };
    const adaDeps = phone("Ada", (e) => adaEvents.push(e));
    const benDeps = phone("Ben", (e) => benEvents.push(e));
    let failPhotos = false;
    const wrap = (drive: Drive): Drive => {
      const download = drive.download.bind(drive);
      drive.download = (path, opts) =>
        failPhotos && path.startsWith("/photos/")
          ? Promise.resolve("timedOut")
          : download(path, opts);
      return drive;
    };
    const open = benDeps.drives.open.bind(benDeps.drives);
    benDeps.drives.open = async (...a: Parameters<typeof open>) => {
      const [err, drive] = await open(...a);
      return err ? [err, null] : [null, wrap(drive!)];
    };
    const ada = createPhotoStore(adaDeps);
    const ben = createPhotoStore(benDeps);
    await ada.ready();
    await ben.ready();
    const created = await ada.createFolder("Trip");
    const folderId = created[1]!.folder.id;
    const shareKey = created[1]!.folder.shareKey;
    const benKey = await joinAsMember(ada, folderId, ben, shareKey);
    await until(async () => {
      const m = (await ada.status()).members;
      return m.length === 2 && m.every((x: { identity?: string }) => x.identity !== undefined);
    });
    const display = join(adaDeps.cacheDir, "one-display.jpg");
    const thumb = join(adaDeps.cacheDir, "one-thumb.jpg");
    writeFileSync(display, new Uint8Array([1, 2, 3]));
    writeFileSync(thumb, new Uint8Array([4, 5]));
    expect((await ada.add(display, "one.jpg", folderId, { thumb }))[0]).toBeNull();

    failPhotos = true;
    expect((await ada.handOver(folderId, benKey))[0]).toBeNull();
    await until(() => benEvents.some((e) => e.event === "handover.waiting"));
    await sleep(3_000);
    expect(benEvents.some((e) => e.event === "handover.ready")).toBe(false);
    expect(adaEvents.some((e) => e.event === "handover.written")).toBe(false);
    await ada.close();
    await ben.close();
  }, 30_000);
});
