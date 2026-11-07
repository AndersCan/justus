/**
 * Peers on another version, on fakes: a newer peer sets `updateNeeded`, an
 * older one (no version before its greeting) lands in `peersBehind`, and
 * neither is asked or answered. Real-swarm delivery is `p2p-scenarios.ts` V1.
 */
import { describe, it, expect } from "vite-plus/test";
import { mkdirSync } from "node:fs";
import { createPhotoStore } from "../src/photo-store.ts";
import { PEER_PROTOCOL } from "../src/versions.ts";
import { FakeSwarm, makeFakeDeps, fakeConnection } from "./fake-drive.ts";
import type { FakeDrive } from "./fake-drive.ts";

type Conn = ReturnType<typeof fakeConnection> & {
  protocol?: number;
  destroyed: boolean;
  destroy(): void;
};

function conn(identity: Buffer, protocol?: number): Conn {
  const c = {
    ...fakeConnection(identity),
    protocol,
    destroyed: false,
    destroy() {
      c.destroyed = true;
    },
  };
  return c;
}

type Extra = {
  log?: (e: { event: string; fields: Record<string, unknown> }) => void;
  openAnswers?: unknown;
};

function build(name: string, swarm?: FakeSwarm, extra: Extra = {}) {
  const own: FakeDrive[] = [];
  const changes: Array<{ cause: string }> = [];
  const deps = makeFakeDeps({
    deviceName: name,
    ...extra,
    onChanged: (c) => changes.push(c),
    ...(swarm ? { makeSwarm: () => swarm } : {}),
    openVersion: (c: unknown, _own: number, onVersion: (remote: number) => void) => {
      const protocol = (c as Conn).protocol;
      if (protocol !== undefined) onVersion(protocol);
    },
    makeDrive: (cs: unknown, key?: Buffer) => {
      const drive = makeFakeDeps().makeDrive(cs, key);
      if (!key) own.push(drive);
      return drive;
    },
  });
  mkdirSync(deps.cacheDir, { recursive: true });
  return { store: createPhotoStore(deps), own, changes };
}

async function setup(extra: Extra = {}) {
  const swarm = new FakeSwarm();
  const me = build("Me", swarm, extra);
  const peer = build("Nils");
  await me.store.ready();
  await peer.store.ready();
  return { swarm, me, peer, peerKey: peer.own[0].key };
}

const behind = async (s: Awaited<ReturnType<typeof setup>>) =>
  (await s.me.store.status()).peersBehind;

describe("peer versions", () => {
  it("same version: nothing refused, identity learned", async () => {
    const s = await setup();
    const c = conn(s.peerKey, PEER_PROTOCOL);
    s.swarm.emit("connection", c);
    await new Promise((r) => setTimeout(r, 20));
    const status = await s.me.store.status();
    expect(status.updateNeeded).toBe(false);
    expect(status.peersBehind).toEqual([]);
    expect(c.destroyed).toBe(false);
    expect(s.me.changes.some((x) => x.cause === "version")).toBe(false);
    const state = s.me.store.debugState() as { connections: { identityKey: string | null }[] };
    expect(state.connections[0].identityKey).toBe(s.peerKey.toString("hex"));
    await s.me.store.close();
    await s.peer.store.close();
  });

  it("newer peer: updateNeeded once, connection destroyed", async () => {
    const s = await setup();
    const c = conn(s.peerKey, PEER_PROTOCOL + 1);
    s.swarm.emit("connection", c);
    s.swarm.emit("connection", conn(s.peerKey, PEER_PROTOCOL + 1));
    expect((await s.me.store.status()).updateNeeded).toBe(true);
    expect(c.destroyed).toBe(true);
    expect(s.me.changes.filter((x) => x.cause === "version")).toHaveLength(1);
    const state = s.me.store.debugState() as { connections: { identityKey: string | null }[] };
    expect(state.connections.every((x) => x.identityKey === null)).toBe(true);
    await s.me.store.close();
    await s.peer.store.close();
  });

  it("greeting without a version: the name from /device.json, once", async () => {
    const s = await setup();
    const c = conn(s.peerKey);
    s.swarm.emit("connection", c);
    s.swarm.emit("connection", conn(s.peerKey));
    for (let i = 0; i < 50 && (await behind(s)).length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(await behind(s)).toEqual(["Nils"]);
    expect((await s.me.store.status()).updateNeeded).toBe(false);
    expect(c.destroyed).toBe(true);
    expect(s.me.changes.filter((x) => x.cause === "version")).toHaveLength(1);
    await s.me.store.close();
    await s.peer.store.close();
  });

  it("an older version below ours is also refused and named", async () => {
    const s = await setup();
    s.swarm.emit("connection", conn(s.peerKey, PEER_PROTOCOL - 1));
    for (let i = 0; i < 50 && (await behind(s)).length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(await behind(s)).toEqual(["Nils"]);
    await s.me.store.close();
    await s.peer.store.close();
  });

  it("an unreadable name falls back to Someone", async () => {
    const s = await setup();
    const slow = new Promise<never>(() => {});
    (s.peer.own[0] as unknown as { get: () => Promise<never> }).get = () => slow;
    const c = conn(s.peerKey);
    s.swarm.emit("connection", c);
    await new Promise((r) => setTimeout(r, 5_300));
    expect(await behind(s)).toEqual(["Someone"]);
    expect(c.destroyed).toBe(true);
    await s.me.store.close();
    await s.peer.store.close();
  }, 15_000);

  it("a refused connection is never asked or answered", async () => {
    const s = await setup();
    const c = conn(s.peerKey, PEER_PROTOCOL + 1);
    s.swarm.emit("connection", c);
    const state = s.me.store.debugState() as { connections: { identityKey: string | null }[] };
    expect(state.connections.map((x) => x.identityKey)).toEqual([null]);
    await s.me.store.close();
    await s.peer.store.close();
  });

  it.each([
    ["newer", PEER_PROTOCOL + 1],
    ["older", PEER_PROTOCOL - 1],
  ])("an answer on a %s connection is dropped and the ask stays waiting", async (_n, protocol) => {
    const events: { event: string; fields: Record<string, unknown> }[] = [];
    let deliver: (v: unknown) => void = () => {};
    const s = await setup({
      log: (e) => events.push(e),
      openAnswers: (_c: unknown, onMessage: (v: unknown) => void) => {
        deliver = onMessage;
        return { send: () => false };
      },
    });
    const code = "a".repeat(64);
    await s.me.store.ask({ code, owner: s.peerKey.toString("hex") });
    s.swarm.emit("connection", conn(s.peerKey, protocol));
    deliver({ code, answer: "declined" });
    await new Promise((r) => setTimeout(r, 50));
    expect(events.some((e) => e.event === "answer.ignored" && e.fields.reason === "version")).toBe(
      true,
    );
    const folders = await s.me.store.folders();
    expect(folders.asks.find((a) => a.code === code)?.status).toBe("waiting");
    await s.me.store.close();
    await s.peer.store.close();
  });

  it("peersBehind never holds more than five names", async () => {
    const s = await setup();
    const names = ["a", "b", "c", "d", "e", "f", "g"];
    for (const [i, n] of names.entries()) {
      const peer = build(n);
      await peer.store.ready();
      s.swarm.emit("connection", conn(peer.own[0].key));
      for (let j = 0; j < 50 && (await behind(s)).length < Math.min(5, i + 1); j++) {
        await new Promise((r) => setTimeout(r, 10));
      }
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
    const drive = s.peer.own[0] as unknown as {
      get: () => Promise<null>;
      update: () => Promise<void>;
    };
    let updates = 0;
    drive.get = async () => null;
    drive.update = async () => {
      updates++;
    };
    s.swarm.emit("connection", conn(s.peerKey));
    for (let i = 0; i < 50 && updates < 2; i++) await new Promise((r) => setTimeout(r, 20));
    expect(updates).toBeGreaterThanOrEqual(2);
    await s.me.store.close();
    const atClose = updates;
    await new Promise((r) => setTimeout(r, 400));
    expect(updates).toBeLessThanOrEqual(atClose + 1);
    await s.peer.store.close();
  });
});
