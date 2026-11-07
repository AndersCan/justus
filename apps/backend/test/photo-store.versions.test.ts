/**
 * Peers on another version, on fakes: a newer peer sets `updateNeeded`, an
 * older one (no version before its greeting) lands in `peersBehind`, and
 * neither is asked or answered. Real-swarm delivery is `p2p-scenarios.ts` V1.
 */
import { describe, it, expect } from "vite-plus/test";
import { mkdirSync } from "node:fs";
import { createPhotoStore } from "../src/photo-store.ts";
import type { PeerEvent, PeerNetwork } from "../src/ports/peer-network.ts";
import { PEER_PROTOCOL } from "../src/versions.ts";
import { createFakeHub, createFakePeerNetwork, type FakeHub } from "./fakes/fake-world.ts";
import { fakeStoreDeps, peerPhone, type FakeStoreDeps } from "./fakes/fake-store-deps.ts";

type Extra = Partial<FakeStoreDeps>;

function build(name: string, hub: FakeHub, extra: Extra = {}) {
  const changes: Array<{ cause: string }> = [];
  const deps = fakeStoreDeps({
    hub,
    deviceName: name,
    ...extra,
    onChanged: (c) => changes.push(c),
  });
  mkdirSync(deps.cacheDir, { recursive: true });
  const store = createPhotoStore(deps);
  const identity = () => (store.debugState() as { identityDrive: string }).identityDrive;
  const topic = () => deps.drives.discoveryKeyOf(identity());
  return { store, deps, changes, identity, topic };
}

async function until(done: () => boolean | Promise<boolean>, ms = 2_000): Promise<void> {
  for (let waited = 0; waited < ms && !(await done()); waited += 10) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function setup(extra: Extra = {}) {
  const hub = createFakeHub();
  const me = build("Me", hub, extra);
  const peer = build("Nils", hub);
  await me.store.ready();
  await peer.store.ready();
  return { hub, me, peer, peerKey: peer.identity() };
}

const behind = async (s: Awaited<ReturnType<typeof setup>>) =>
  (await s.me.store.status()).peersBehind;

const connections = (s: Awaited<ReturnType<typeof setup>>) =>
  (s.me.store.debugState() as { connections: { identityKey: string | null }[] }).connections;

describe("peer versions", () => {
  it("same version: nothing refused, identity learned", async () => {
    const s = await setup();
    const phone = peerPhone(s.hub, { identityKey: s.peerKey, protocol: PEER_PROTOCOL });
    phone.meet(s.me.topic());
    await until(() => connections(s)[0]?.identityKey === s.peerKey);
    const status = await s.me.store.status();
    expect(status.updateNeeded).toBe(false);
    expect(status.peersBehind).toEqual([]);
    expect(phone.network.connectionCount()).toBe(1);
    expect(s.me.changes.some((x) => x.cause === "version")).toBe(false);
    expect(connections(s)[0].identityKey).toBe(s.peerKey);
    await s.me.store.close();
    await s.peer.store.close();
  });

  it("newer peer: updateNeeded once, connection destroyed", async () => {
    const s = await setup();
    const phone = peerPhone(s.hub, { identityKey: s.peerKey, protocol: PEER_PROTOCOL + 1 });
    const second = peerPhone(s.hub, { identityKey: s.peerKey, protocol: PEER_PROTOCOL + 1 });
    phone.meet(s.me.topic());
    second.meet(s.me.topic());
    await until(async () => (await s.me.store.status()).updateNeeded && second.events.length >= 3);
    expect((await s.me.store.status()).updateNeeded).toBe(true);
    expect(phone.network.connectionCount()).toBe(0);
    expect(s.me.changes.filter((x) => x.cause === "version")).toHaveLength(1);
    expect(connections(s).every((x) => x.identityKey === null)).toBe(true);
    await s.me.store.close();
    await s.peer.store.close();
  });

  it("greeting without a version: the name from /device.json, once", async () => {
    const s = await setup();
    const phone = peerPhone(s.hub, { identityKey: s.peerKey, legacy: true });
    const second = peerPhone(s.hub, { identityKey: s.peerKey, legacy: true });
    phone.meet(s.me.topic());
    second.meet(s.me.topic());
    await until(async () => (await behind(s)).length > 0);
    expect(await behind(s)).toEqual(["Nils"]);
    expect((await s.me.store.status()).updateNeeded).toBe(false);
    await until(() => phone.network.connectionCount() === 0);
    expect(phone.network.connectionCount()).toBe(0);
    expect(s.me.changes.filter((x) => x.cause === "version")).toHaveLength(1);
    await s.me.store.close();
    await s.peer.store.close();
  });

  it("an older version below ours is also refused and named", async () => {
    const s = await setup();
    const phone = peerPhone(s.hub, { identityKey: s.peerKey, protocol: PEER_PROTOCOL - 1 });
    phone.meet(s.me.topic());
    await until(async () => (await behind(s)).length > 0);
    expect(await behind(s)).toEqual(["Nils"]);
    await s.me.store.close();
    await s.peer.store.close();
  });

  it("an unreadable name falls back to Someone", async () => {
    const s = await setup();
    const copy = await s.me.deps.drives.open(s.peerKey, { timeoutMs: 1_000 });
    if (copy[0] || !copy[1]) throw new Error("peer identity drive did not open");
    const slow = new Promise<never>(() => {});
    copy[1].readSmall = () => slow;
    const phone = peerPhone(s.hub, { identityKey: s.peerKey, legacy: true });
    phone.meet(s.me.topic());
    await until(async () => (await behind(s)).length > 0, 8_000);
    expect(await behind(s)).toEqual(["Someone"]);
    await until(() => phone.network.connectionCount() === 0);
    expect(phone.network.connectionCount()).toBe(0);
    await s.me.store.close();
    await s.peer.store.close();
  }, 15_000);

  it("a refused connection is never asked or answered", async () => {
    const s = await setup();
    const phone = peerPhone(s.hub, { identityKey: s.peerKey, protocol: PEER_PROTOCOL + 1 });
    phone.meet(s.me.topic());
    await until(async () => (await s.me.store.status()).updateNeeded);
    expect((await s.me.store.status()).updateNeeded).toBe(true);
    // The fake drops the refused connection at once, so the list is `[]` rather
    // than `[null]`; "never identified" is the same meaning.
    expect(connections(s).every((x) => x.identityKey === null)).toBe(true);
    await s.me.store.close();
    await s.peer.store.close();
  });

  it.each([
    ["newer", PEER_PROTOCOL + 1],
    ["older", PEER_PROTOCOL - 1],
  ])("an answer on a %s connection is dropped and the ask stays waiting", async (_n, protocol) => {
    const events: { event: string; fields: Record<string, unknown> }[] = [];
    const hub = createFakeHub();
    // I8: the fake cannot deliver an answer on a connection the store refused,
    // so the store's network is wrapped to keep that connection open and to
    // report the connection id.
    const net = createFakePeerNetwork({ hub });
    let emit: (e: PeerEvent) => void = () => {};
    const seen: PeerEvent[] = [];
    const network: PeerNetwork = {
      ...net,
      start: (identity: string, on: (e: PeerEvent) => void, p?: number) => {
        emit = on;
        net.start(
          identity,
          (e) => {
            on(e);
            seen.push(e);
          },
          p,
        );
      },
      drop: () => {},
    };
    const me = build("Me", hub, { network, log: (e: (typeof events)[number]) => events.push(e) });
    const peer = build("Nils", hub);
    await me.store.ready();
    await peer.store.ready();
    const code = "a".repeat(64);
    await me.store.ask({ code, owner: peer.identity() });
    const phone = peerPhone(hub, { identityKey: peer.identity(), protocol });
    phone.meet(me.topic());
    await until(() => seen.some((e) => e.type === "version"));
    const conn = seen.find((e) => e.type === "version")!.conn;
    emit({ type: "answer", conn, value: { code, answer: "declined" } });
    await until(() => events.some((e) => e.event === "answer.ignored"));
    expect(events.some((e) => e.event === "answer.ignored" && e.fields.reason === "version")).toBe(
      true,
    );
    const folders = await me.store.folders();
    expect(folders.asks.find((a) => a.code === code)?.status).toBe("waiting");
    await me.store.close();
    await peer.store.close();
  });

  it("peersBehind never holds more than five names", async () => {
    const s = await setup();
    const names = ["a", "b", "c", "d", "e", "f", "g"];
    for (const [i, n] of names.entries()) {
      const peer = build(n, s.hub);
      await peer.store.ready();
      peerPhone(s.hub, { identityKey: peer.identity(), legacy: true }).meet(s.me.topic());
      await until(async () => (await behind(s)).length >= Math.min(5, i + 1));
      await peer.store.close();
    }
    expect((await behind(s)).length).toBe(5);
    await s.me.store.close();
    await s.peer.store.close();
  });
});

describe("older peer whose name never arrives", () => {
  it("stops polling its drive once the store closes", async () => {
    const s = await setup();
    const copy = await s.me.deps.drives.open(s.peerKey, { timeoutMs: 1_000 });
    if (copy[0] || !copy[1]) throw new Error("peer identity drive did not open");
    let updates = 0;
    copy[1].readSmall = async () => undefined;
    copy[1].update = async () => {
      updates++;
    };
    peerPhone(s.hub, { identityKey: s.peerKey, legacy: true }).meet(s.me.topic());
    await until(() => updates >= 2, 1_000);
    expect(updates).toBeGreaterThanOrEqual(2);
    await s.me.store.close();
    const atClose = updates;
    await new Promise((r) => setTimeout(r, 400));
    expect(updates).toBeLessThanOrEqual(atClose + 1);
    await s.peer.store.close();
  });
});
