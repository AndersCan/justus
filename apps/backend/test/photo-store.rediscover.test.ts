import { afterEach, describe, expect, it } from "vite-plus/test";
import { createPhotoStore } from "../src/photo-store.ts";
import type { PhotoStore } from "../src/photo-store.ts";
import type { P2pEvent } from "../src/p2p-log.ts";
import { makeFakeDeps } from "./fake-drive.ts";

type PeerlessDrive = { core: { peers?: unknown[] }; discoveryKey: Buffer };

const FIRST_RETRY_MS = 800;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Every drive the store makes reports no peers, so each join keeps retrying.
 * `keyless` lists the drives made without a key, in order: the device identity
 * drive first, then each per-album member drive. */
function build(name: string, deps?: ReturnType<typeof makeFakeDeps>) {
  const events: P2pEvent[] = [];
  const keyless: PeerlessDrive[] = [];
  const base = deps ?? makeFakeDeps({ deviceName: name });
  const store = createPhotoStore({
    ...base,
    deviceName: name,
    log: (e: P2pEvent) => events.push(e),
    makeDrive: (cs: unknown, key?: Buffer) => {
      const drive = base.makeDrive(cs, key) as PeerlessDrive;
      drive.core.peers = drive.core.peers ?? [];
      if (!key) keyless.push(drive);
      return drive;
    },
  } as typeof base);
  return { store, events, keyless, base };
}

/** First attempts logged for a topic: one per `rediscover` call on that drive. */
function firstAttempts(events: P2pEvent[], discoveryKey: Buffer) {
  const topic = discoveryKey.toString("hex").slice(0, 8);
  return events.filter(
    (e) => e.event === "rediscover.attempt" && e.fields.topic === topic && e.fields.n === 1,
  ).length;
}

/** The shared fake registry resolves a drive by key to the one the store made. */
function discoveryKeyOf(keyHex: string) {
  return (makeFakeDeps().makeDrive({}, Buffer.from(keyHex, "hex")) as PeerlessDrive).discoveryKey;
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
    const a = build("A");
    track(a.store);
    await a.store.ready();
    await wait(FIRST_RETRY_MS);
    expect(firstAttempts(a.events, a.keyless[0].discoveryKey)).toBe(1);
  });

  it("retries a created album's topic once", async () => {
    const a = build("A");
    track(a.store);
    await a.store.ready();
    const created = await a.store.createFolder("Trip");
    expect(created[0]).toBeNull();
    await wait(FIRST_RETRY_MS);
    expect(firstAttempts(a.events, discoveryKeyOf(created[1]!.folder.shareKey))).toBe(1);
  });

  it("retries a joiner's album topic on open and again when it files the request", async () => {
    const creator = build("Creator");
    track(creator.store);
    await creator.store.ready();
    const created = await creator.store.createFolder("Trip");
    const shareKey = created[1]!.folder.shareKey;

    const joiner = build("Joiner");
    track(joiner.store);
    await joiner.store.ready();
    expect((await joiner.store.join(shareKey))[0]).toBeNull();
    await wait(FIRST_RETRY_MS);

    // openDriveWithTopic, then announceOwnDriveOnTopic from fileJoinRequest.
    expect(firstAttempts(joiner.events, discoveryKeyOf(shareKey))).toBe(2);
    // openSelfDrive: the joiner's own drive for this album.
    expect(firstAttempts(joiner.events, joiner.keyless[1].discoveryKey)).toBe(1);
  });

  it("retries a persisted own album's topic when the store reopens", async () => {
    const deps = makeFakeDeps({ deviceName: "A" });
    const first = build("A", deps);
    await first.store.ready();
    const created = await first.store.createFolder("Trip");
    const shareKey = created[1]!.folder.shareKey;
    await first.store.close();

    const second = build("A", deps);
    track(second.store);
    await second.store.ready();
    await wait(FIRST_RETRY_MS);
    expect(firstAttempts(second.events, discoveryKeyOf(shareKey))).toBe(1);
  });

  it("stops retrying once the drive has a peer", async () => {
    const a = build("A");
    track(a.store);
    await a.store.ready();
    a.keyless[0].core.peers = [{}];
    await wait(FIRST_RETRY_MS);
    expect(firstAttempts(a.events, a.keyless[0].discoveryKey)).toBe(0);
  });

  it("stops retrying after close", async () => {
    const a = build("A");
    await a.store.ready();
    await a.store.close();
    await wait(FIRST_RETRY_MS);
    expect(a.events.filter((e) => e.event === "rediscover.attempt")).toEqual([]);
  });
});
