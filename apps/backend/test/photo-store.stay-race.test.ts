/**
 * Stay Admin racing Ben's "ready": Ben's phone took the package and replied,
 * and Ada taps Stay Admin before or while her phone acts on the reply.
 */
import { describe, it, expect } from "vite-plus/test";
import { mkdirSync } from "node:fs";
import { createPhotoStore, PhotoError } from "../src/photo-store.ts";
import type { PeerEvent, PeerNetwork } from "../src/ports/peer-network.ts";
import { createFakeHub, addFakeNode, setFakeNodeConnected } from "./fakes/fake-world.ts";
import { FakeLoopbackServer, fakeStoreDeps, joinAsMember } from "./fakes/fake-store-deps.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(check: () => boolean | Promise<boolean>, ms = 12_000) {
  const deadline = Date.now() + ms;
  while (!(await check()) && Date.now() < deadline) await sleep(25);
  expect(await check()).toBe(true);
}

/** Holds back "ready" answers on Ada's phone until `release` replays them. */
function holdingReady(network: PeerNetwork) {
  const held: PeerEvent[] = [];
  let deliver: ((e: PeerEvent) => void) | undefined;
  const start = network.start.bind(network);
  network.start = (identity, onEvent, protocol) => {
    deliver = onEvent;
    return start(
      identity,
      (e) => {
        if (e.type === "answer" && JSON.stringify(e.value).includes('"handoverReady"')) {
          held.push(e);
          return;
        }
        onEvent(e);
      },
      protocol,
    );
  };
  return { held, release: () => held.splice(0).forEach((e) => deliver!(e)) };
}

/** While `slow.on`, every drive this phone opens takes 1.5 s to update. */
function slowing(drives: { open: (...a: never[]) => Promise<unknown> }, slow: { on: boolean }) {
  const open = drives.open.bind(drives) as (...a: unknown[]) => Promise<[unknown, unknown]>;
  (drives as { open: unknown }).open = async (...args: unknown[]) => {
    const [error, drive] = await open(...args);
    if (drive) {
      const d = drive as { update: () => Promise<void> };
      const update = d.update.bind(d);
      d.update = async () => {
        if (slow.on) await sleep(1_500);
        return update();
      };
    }
    return [error, drive];
  };
}

function phone(hub: ReturnType<typeof createFakeHub>, deviceName: string, holdReady = false) {
  const node = addFakeNode(hub);
  setFakeNodeConnected({ hub, node, connected: true });
  const deps = fakeStoreDeps({ hub, node, deviceName, server: new FakeLoopbackServer() });
  const slow = { on: false };
  slowing(deps.drives as never, slow);
  const ready = holdReady ? holdingReady(deps.network) : undefined;
  mkdirSync(deps.cacheDir, { recursive: true });
  return { deps, node, ready, slow, store: createPhotoStore(deps) };
}
type Phone = ReturnType<typeof phone>;
const trip = async (p: Phone) => (await p.store.folders()).folders.find((f) => f.name === "Trip")!;

async function scene() {
  const hub = createFakeHub();
  const ada = phone(hub, "Ada", true);
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
  const read = async (key: string, path: string) => {
    const [openErr, drive] = await ada.deps.drives.open(key, { timeoutMs: 5_000 });
    if (openErr) throw openErr;
    return (await drive.readSmall(path, 1 << 20, { timeoutMs: 2_000 })) ?? null;
  };
  return { hub, ada, ben, folderId, shareKey, benKey, read };
}

describe("Stay Admin and Ben's ready", () => {
  it("a ready that arrives after Stay Admin writes nothing", async () => {
    const s = await scene();
    expect((await s.ada.store.handOver(s.folderId, s.benKey))[0]).toBeNull();
    await until(() => s.ada.ready!.held.length > 0);
    expect((await s.ada.store.stayAdmin(s.folderId))[0]).toBeNull();
    s.ada.ready!.release();
    await sleep(3_000);
    expect(await s.read(s.shareKey, "/admin.json")).toBeNull();
    expect((await trip(s.ada)).role).toBe("creator");
    expect((await trip(s.ada)).handingOver).toBeUndefined();
    expect((await trip(s.ben)).role).toBe("member");
    for (const p of [s.ada, s.ben]) await p.store.close();
  }, 30_000);

  it("Stay Admin while Ada's phone acts on the ready either refuses or keeps the album", async () => {
    const s = await scene();
    expect((await s.ada.store.handOver(s.folderId, s.benKey))[0]).toBeNull();
    await until(() => s.ada.ready!.held.length > 0);
    // Ada's phone takes a while to check Ben's copy; she taps Stay Admin meanwhile.
    s.ada.slow.on = true;
    s.ada.ready!.release();
    await sleep(300);
    const [error] = await s.ada.store.stayAdmin(s.folderId);
    s.ada.slow.on = false;
    await sleep(3_000);
    // Stay Admin either waited and was refused, or the album stayed: never "ok" and then handed over.
    if (error) expect(error.code).toBe(PhotoError.HANDOVER_REFUSED);
    else expect((await trip(s.ben)).role).toBe("member");
    for (const p of [s.ada, s.ben]) await p.store.close();
  }, 30_000);
});
