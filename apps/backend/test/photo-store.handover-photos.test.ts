/**
 * Ada adds a photo after Ben's phone fetched her photos and before she acts on
 * his reply: her phone does not hand over, sends the package again, and Ben's
 * phone fetches the new photo before the handover is written.
 */
import { describe, it, expect } from "vite-plus/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPhotoStore } from "../src/photo-store.ts";
import type { P2pEvent } from "../src/p2p-log.ts";
import type { PeerEvent, PeerNetwork } from "../src/ports/peer-network.ts";
import { createFakeHub, addFakeNode, setFakeNodeConnected } from "./fakes/fake-world.ts";
import { FakeLoopbackServer, fakeStoreDeps, joinAsMember } from "./fakes/fake-store-deps.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(check: () => boolean | Promise<boolean>, ms = 12_000) {
  const deadline = Date.now() + ms;
  while (!(await check()) && Date.now() < deadline) await sleep(25);
  expect(await check()).toBe(true);
}

/** Holds back the first "ready" answer on Ada's phone until `release` replays it. */
function holdingReady(network: PeerNetwork) {
  const held: PeerEvent[] = [];
  let deliver: ((e: PeerEvent) => void) | undefined;
  let open = false;
  const start = network.start.bind(network);
  network.start = (identity, onEvent, protocol) => {
    deliver = onEvent;
    return start(
      identity,
      (e) => {
        if (!open && e.type === "answer" && JSON.stringify(e.value).includes('"handoverReady"')) {
          held.push(e);
          return;
        }
        onEvent(e);
      },
      protocol,
    );
  };
  return {
    held,
    release: () => {
      open = true;
      held.splice(0).forEach((e) => deliver!(e));
    },
  };
}

describe("a photo Ada adds while Ben's phone is answering", () => {
  it("is fetched before the handover is written", async () => {
    const hub = createFakeHub();
    const events: P2pEvent[] = [];
    const phone = (deviceName: string, log?: (e: P2pEvent) => void) => {
      const node = addFakeNode(hub);
      setFakeNodeConnected({ hub, node, connected: true });
      return fakeStoreDeps({ hub, node, deviceName, server: new FakeLoopbackServer(), log });
    };
    const adaDeps = phone("Ada", (e) => events.push(e));
    const benDeps = phone("Ben");
    const ready = holdingReady(adaDeps.network);
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

    expect((await ada.handOver(folderId, benKey))[0]).toBeNull();
    await until(() => ready.held.length > 0);
    const display = join(adaDeps.cacheDir, "late-display.jpg");
    const thumb = join(adaDeps.cacheDir, "late-thumb.jpg");
    writeFileSync(display, new Uint8Array([1, 2, 3]));
    writeFileSync(thumb, new Uint8Array([4, 5]));
    expect((await ada.add(display, "late.jpg", folderId, { thumb }))[0]).toBeNull();
    ready.release();

    await until(() => events.some((e) => e.event === "handover.written"));
    const order = events.map((e) => e.event);
    expect(order.indexOf("handover.stale")).toBeGreaterThan(-1);
    expect(order.indexOf("handover.stale")).toBeLessThan(order.indexOf("handover.written"));
    expect(events.find((e) => e.event === "handover.stale")!.fields.reason).toBe("photos");

    await ada.close();
    const [openErr, onBen] = await benDeps.drives.open(shareKey, { timeoutMs: 5_000 });
    expect(openErr).toBeNull();
    const paths: string[] = [];
    for await (const e of onBen!.list("/photos")) paths.push(e.path);
    expect(paths).toHaveLength(1);
    expect(await onBen!.download(paths[0]!, { timeoutMs: 2_000 })).toBe("here");
    await ben.close();
  }, 30_000);
});
