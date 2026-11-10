/**
 * Peers on another version, on fakes: a newer peer sets `updateNeeded`, an
 * older one (no version before its greeting) lands in `peersBehind`, and
 * neither is asked or answered. Real-swarm delivery is `p2p-scenarios.ts` V1.
 */
import { describe, it, expect } from "vite-plus/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTmpDir } from "./tmp-dirs.ts";
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

  const askTo = async (
    s: Awaited<ReturnType<typeof setup>>,
    owner: string,
    code = "c".repeat(64),
  ) => {
    const asked = await s.me.store.ask({ code, owner, albumName: "Summer", ownerName: "Nils" });
    expect(asked[0]).toBeNull();
  };
  const marks = async (s: Awaited<ReturnType<typeof setup>>) =>
    (await s.me.store.folders()).asks.map((a) => a.whoMustUpdate);

  it("a newer phone that is the ask's Admin marks the ask you", async () => {
    const s = await setup();
    await askTo(s, s.peerKey);
    const phone = peerPhone(s.hub, { identityKey: s.peerKey, protocol: PEER_PROTOCOL + 1 });
    phone.meet(s.me.topic());
    await until(async () => (await marks(s))[0] === "you");
    expect(await marks(s)).toEqual(["you"]);
    expect(s.me.changes.filter((x) => x.cause === "version").length).toBeGreaterThan(0);
    await until(() => phone.network.connectionCount() === 0);
    expect(phone.network.connectionCount()).toBe(0);
    await s.me.store.close();
    await s.peer.store.close();
  });

  it("a newer phone that is someone else leaves the ask unmarked", async () => {
    const s = await setup();
    await askTo(s, s.peerKey);
    const stranger = build("Eve", s.hub).identity();
    const phone = peerPhone(s.hub, { identityKey: stranger, protocol: PEER_PROTOCOL + 1 });
    phone.meet(s.me.topic());
    await until(async () => (await s.me.store.status()).updateNeeded);
    await until(() => phone.network.connectionCount() === 0);
    expect(await marks(s)).toEqual([undefined]);
    expect((await s.me.store.status()).updateNeeded).toBe(true);
    await s.me.store.close();
    await s.peer.store.close();
  });

  /** A phone whose saved file already holds asks to the Admin, then a newer phone of that Admin meets it. */
  async function savedAsks(statuses: string[]) {
    const hub = createFakeHub();
    const peer = build("Nils", hub);
    await peer.store.ready();
    const storageDir = makeTmpDir("justus-versions-");
    writeFileSync(
      join(storageDir, "justus.json"),
      JSON.stringify({
        version: 2,
        name: "Me",
        folders: [],
        activeFolderId: null,
        asks: statuses.map((status, i) => ({
          code: String(i).repeat(64),
          owner: peer.identity(),
          albumName: "Trip",
          ownerName: "Nils",
          askedAt: 1,
          status,
        })),
        offers: [],
        gone: [],
      }),
    );
    const me = build("Me", hub, { storageDir });
    await me.store.ready();
    const phone = peerPhone(hub, { identityKey: peer.identity(), protocol: PEER_PROTOCOL + 1 });
    phone.meet(me.topic());
    await until(async () => (await me.store.status()).updateNeeded);
    await until(() => phone.network.connectionCount() === 0);
    return { me, peer };
  }

  it("only a waiting ask is marked, a declined one is not", async () => {
    const { me, peer } = await savedAsks(["waiting", "declined"]);
    await until(async () => (await me.store.folders()).asks.some((a) => a.whoMustUpdate));
    const asks = (await me.store.folders()).asks;
    expect(asks.map((a) => [a.status, a.whoMustUpdate])).toEqual([
      ["waiting", "you"],
      ["declined", undefined],
    ]);
    await me.store.close();
    await peer.store.close();
  });

  it("an Admin with only a declined ask is not marked and causes no extra push", async () => {
    const { me, peer } = await savedAsks(["declined"]);
    const asks = (await me.store.folders()).asks;
    expect(asks.map((a) => a.whoMustUpdate)).toEqual([undefined]);
    // one push comes from updateNeeded; a mark would add a second
    expect(me.changes.filter((x) => x.cause === "version")).toHaveLength(1);
    await me.store.close();
    await peer.store.close();
  });

  it("the Admin's phone on the same version clears the mark", async () => {
    const s = await setup();
    await askTo(s, s.peerKey);
    peerPhone(s.hub, { identityKey: s.peerKey, protocol: PEER_PROTOCOL + 1 }).meet(s.me.topic());
    await until(async () => (await marks(s))[0] === "you");
    const before = s.me.changes.filter((x) => x.cause === "version").length;
    peerPhone(s.hub, { identityKey: s.peerKey, protocol: PEER_PROTOCOL }).meet(s.me.topic());
    await until(async () => (await marks(s))[0] === undefined);
    expect(await marks(s)).toEqual([undefined]);
    expect(s.me.changes.filter((x) => x.cause === "version").length).toBe(before + 1);
    await s.me.store.close();
    await s.peer.store.close();
  });

  it("an ask made after the meeting is not marked", async () => {
    const s = await setup();
    const phone = peerPhone(s.hub, { identityKey: s.peerKey, protocol: PEER_PROTOCOL + 1 });
    phone.meet(s.me.topic());
    await until(() => phone.network.connectionCount() === 0);
    await askTo(s, s.peerKey);
    expect(await marks(s)).toEqual([undefined]);
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

  it("an unreadable name holds the link, and falls back to Someone if the peer closes it", async () => {
    const s = await setup();
    const copy = await s.me.deps.drives.open(s.peerKey, { timeoutMs: 1_000 });
    if (copy[0] || !copy[1]) throw new Error("peer identity drive did not open");
    const slow = new Promise<never>(() => {});
    copy[1].readSmall = () => slow;
    const phone = peerPhone(s.hub, { identityKey: s.peerKey, legacy: true });
    phone.meet(s.me.topic());
    await until(() => phone.network.connectionCount() === 1);
    // Past the old 5 s give-up: still held, nothing named.
    await new Promise((r) => setTimeout(r, 6_000));
    expect(phone.network.connectionCount()).toBe(1);
    expect(await behind(s)).toEqual([]);
    await phone.network.close();
    await until(async () => (await behind(s)).length > 0);
    expect(await behind(s)).toEqual(["Someone"]);
    await s.me.store.close();
    await s.peer.store.close();
  }, 20_000);

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
    // The ask also connects to Nils's own phone, at the right version: pick the odd one out.
    const odd = (e: PeerEvent) => e.type === "version" && e.protocol === protocol;
    await until(() => seen.some(odd));
    const conn = seen.find(odd)!.conn;
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
