import createTestnet from "hyperdht/testnet";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vite-plus/test";
import { createHyperPeerNetwork } from "../src/adapters/hyper-peer-network.ts";
import { createPhotoStore } from "../src/photo-store.ts";
import type { PhotoStore } from "../src/photo-store.ts";
import { createP2pLog } from "../src/p2p-log.ts";
import type { P2pEvent } from "../src/p2p-log.ts";
import type { DriveStore } from "../src/ports/drive-store.ts";
import { createFakeHub } from "./fakes/fake-world.ts";
import type { FakeHub } from "./fakes/fake-world.ts";
import { fakeStoreDeps, restarted } from "./fakes/fake-store-deps.ts";
import type { FakeStoreDeps } from "./fakes/fake-store-deps.ts";

const FIRST_RETRY_MS = 800;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let testnet: Awaited<ReturnType<typeof createTestnet>>;
beforeAll(async () => {
  testnet = await createTestnet(3);
});
afterAll(async () => {
  await testnet.destroy();
});

/** Every drive reports the peer count in `peers` (none by default), so each join keeps retrying. */
function peerless(drives: DriveStore, peers: Map<string, number>): DriveStore {
  const withPeers = <T extends { key: string; stats(): { length: number; peers: number } }>(
    d: T,
  ): T => {
    const orig = d.stats.bind(d);
    d.stats = () => ({ ...orig(), peers: peers.get(d.key) ?? 0 });
    return d;
  };
  return {
    ...drives,
    async openOwn(namespace) {
      return withPeers(await drives.openOwn(namespace));
    },
    async open(key, opts) {
      const opened = await drives.open(key, opts);
      if (opened[0]) return opened;
      return [null, withPeers(opened[1])];
    },
  };
}

/** A store on the real network adapter over the testnet, with fake drives on `hub`.
 * Pass `prior` to restart the same phone. */
function build(name: string, hub: FakeHub, prior?: FakeStoreDeps) {
  const events: P2pEvent[] = [];
  const peers = new Map<string, number>();
  const sink = (e: P2pEvent) => events.push(e);
  const base = prior ? restarted(prior) : fakeStoreDeps({ hub, deviceName: name });
  const drives = peerless(base.drives, peers);
  const deps: FakeStoreDeps = {
    ...base,
    drives,
    network: createHyperPeerNetwork({
      bootstrap: testnet.bootstrap,
      replicate: () => {},
      log: createP2pLog(sink),
    }),
    log: sink,
  };
  const store = createPhotoStore(deps);
  const identity = () => (store.debugState() as { identityDrive: string }).identityDrive;
  return { store, events, peers, deps, identity, discoveryKeyOf: drives.discoveryKeyOf };
}

/** First attempts logged for a topic: one per `rediscover` call on that drive. */
function firstAttempts(events: P2pEvent[], discoveryKey: string) {
  const topic = discoveryKey.slice(0, 8);
  return events.filter(
    (e) => e.event === "rediscover.attempt" && e.fields.topic === topic && e.fields.n === 1,
  ).length;
}

describe("PhotoStore server-mode joins retry the peer lookup", () => {
  const open: PhotoStore[] = [];
  const track = (s: PhotoStore) => {
    open.push(s);
    return s;
  };
  afterEach(async () => {
    await Promise.all(open.splice(0).map((s) => s.close()));
  });

  it("retries the device identity drive's topic once at boot", async () => {
    const a = build("A", createFakeHub());
    track(a.store);
    await a.store.ready();
    await wait(FIRST_RETRY_MS);
    expect(firstAttempts(a.events, a.discoveryKeyOf(a.identity()))).toBe(1);
  });

  it("retries a created album's topic once", async () => {
    const a = build("A", createFakeHub());
    track(a.store);
    await a.store.ready();
    const created = await a.store.createFolder("Trip");
    expect(created[0]).toBeNull();
    await wait(FIRST_RETRY_MS);
    expect(firstAttempts(a.events, a.discoveryKeyOf(created[1]!.folder.shareKey))).toBe(1);
  });

  it("retries a joiner's album topic on open and again when it files the request", async () => {
    const hub = createFakeHub();
    const creator = build("Creator", hub);
    track(creator.store);
    await creator.store.ready();
    const created = await creator.store.createFolder("Trip");
    const shareKey = created[1]!.folder.shareKey;

    const joiner = build("Joiner", hub);
    track(joiner.store);
    await joiner.store.ready();
    expect((await joiner.store.join(shareKey))[0]).toBeNull();
    await wait(FIRST_RETRY_MS);

    // openDriveWithTopic, then announceOwnDriveOnTopic from fileJoinRequest.
    expect(firstAttempts(joiner.events, joiner.discoveryKeyOf(shareKey))).toBe(2);
    // openSelfDrive: the joiner's own drive for this album.
    const ownKey = (await joiner.store.folders()).folders.find(
      (f) => f.shareKey === shareKey,
    )!.driveKey;
    expect(firstAttempts(joiner.events, joiner.discoveryKeyOf(ownKey))).toBe(1);
  });

  it("retries a persisted own album's topic when the store reopens", async () => {
    const hub = createFakeHub();
    const first = build("A", hub);
    await first.store.ready();
    const created = await first.store.createFolder("Trip");
    const shareKey = created[1]!.folder.shareKey;
    await first.store.close();

    const second = build("A", hub, first.deps);
    track(second.store);
    await second.store.ready();
    await wait(FIRST_RETRY_MS);
    expect(firstAttempts(second.events, second.discoveryKeyOf(shareKey))).toBe(1);
  });

  it("stops retrying once the drive has a peer", async () => {
    const a = build("A", createFakeHub());
    track(a.store);
    await a.store.ready();
    a.peers.set(a.identity(), 1);
    await wait(FIRST_RETRY_MS);
    expect(firstAttempts(a.events, a.discoveryKeyOf(a.identity()))).toBe(0);
  });

  it("stops retrying after close", async () => {
    const a = build("A", createFakeHub());
    await a.store.ready();
    await a.store.close();
    await wait(FIRST_RETRY_MS);
    expect(a.events.filter((e) => e.event === "rediscover.attempt")).toEqual([]);
  });
});
