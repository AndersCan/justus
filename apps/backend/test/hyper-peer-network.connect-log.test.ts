import { afterEach, expect, it } from "vite-plus/test";
import createTestnet from "hyperdht/testnet";
import { createHyperPeerNetwork } from "../src/adapters/hyper-peer-network.ts";
import type { P2pEvent, P2pLog } from "../src/p2p-log.ts";
import type { PeerEvent } from "../src/ports/peer-network.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
}, 20_000);

function phone(bootstrap: string[], events: P2pEvent[]) {
  const network = createHyperPeerNetwork({
    bootstrap,
    replicate: () => {},
    log: ((event, fields = {}) => void events.push({ event, fields })) as P2pLog,
  });
  const connected = new Promise<void>((resolve) =>
    network.start(
      "a".repeat(64),
      (e: PeerEvent) => {
        if (e.type === "connected") resolve();
      },
      1,
    ),
  );
  cleanups.push(() => network.close());
  return { network, connected };
}

it("logs the DHT state at join, each lookup's peers and each dial", async () => {
  const net = await createTestnet(5);
  cleanups.push(() => net.destroy());
  const aLog: P2pEvent[] = [];
  const bLog: P2pEvent[] = [];
  const a = phone(net.bootstrap, aLog);
  const b = phone(net.bootstrap, bLog);
  const topic = "b".repeat(64);
  a.network.join(topic, { server: true });
  b.network.join(topic, { server: false });
  b.network.findPeers(topic, () => false);
  await Promise.all([a.connected, b.connected]);

  const join = aLog.find((e) => e.event === "topic.join");
  expect(join?.fields).toMatchObject({ served: true, firewalled: expect.any(Boolean) });
  expect(join?.fields.table).toEqual(expect.any(Number));
  const all = [...aLog, ...bLog].map((e) => e.event);
  expect(all).toContain("connect.attempt");
  expect(bLog.some((e) => e.event === "lookup.peer")).toBe(true);
  expect(bLog.some((e) => e.event === "lookup.done" && Number(e.fields.peers) > 0)).toBe(true);
  // The rediscover loop looks again at 500 ms: the second lookup counts its own peers.
  await new Promise((r) => setTimeout(r, 1500));
  const lookups = bLog.filter((e) => e.event === "lookup.done" && e.fields.kind === "lookup");
  expect(lookups.length).toBeGreaterThan(1);
  expect(Number(lookups[1].fields.peers)).toBeGreaterThan(0);
  // Each lookup counts only its own peers: no more than were reported since the previous one finished.
  const at = lookups.map((e) => bLog.indexOf(e));
  for (let i = 1; i < lookups.length; i++) {
    const reported = bLog.slice(at[i - 1] + 1, at[i]).filter((e) => e.event === "lookup.peer");
    expect(Number(lookups[i].fields.peers)).toBeLessThanOrEqual(reported.length);
  }
}, 20_000);

it("a served topic only announces, so no lookup.done says kind=lookup", async () => {
  const net = await createTestnet(5);
  cleanups.push(() => net.destroy());
  const events: P2pEvent[] = [];
  const network = createHyperPeerNetwork({
    bootstrap: net.bootstrap,
    replicate: () => {},
    log: ((event, fields = {}) => void events.push({ event, fields })) as P2pLog,
  });
  network.start("a".repeat(64), () => {}, 1);
  cleanups.push(() => network.close());
  const topic = "b".repeat(64);
  network.join(topic, { server: true });
  // No peer: the rediscover loop refreshes the topic at 500 ms, a second (non-first) announce.
  network.findPeers(topic, () => false);
  await new Promise((r) => setTimeout(r, 2500));
  const done = events.filter((e) => e.event === "lookup.done").map((e) => e.fields.kind);
  expect(done.filter((k) => k === "lookup")).toEqual([]);
}, 20_000);

it("a dial that opened and later dropped is not logged as a failed dial", async () => {
  const net = await createTestnet(5);
  cleanups.push(() => net.destroy());
  const logs: P2pEvent[][] = [[], []];
  const phones = logs.map((events) => {
    const network = createHyperPeerNetwork({
      bootstrap: net.bootstrap,
      replicate: () => {},
      log: ((event, fields = {}) => void events.push({ event, fields })) as P2pLog,
    });
    const connected = new Promise<void>((resolve) =>
      network.start("a".repeat(64), (e: PeerEvent) => e.type === "connected" && resolve(), 1),
    );
    cleanups.push(() => network.close());
    return { network, connected };
  });
  const topic = "b".repeat(64);
  phones[0].network.join(topic, { server: true });
  phones[1].network.join(topic, { server: false });
  phones[1].network.findPeers(topic, () => false);
  await Promise.all(phones.map((p) => p.connected));
  await phones[0].network.close();
  await new Promise((r) => setTimeout(r, 1000));
  const dialer = logs[1].map((e) => e.event);
  expect(dialer).toContain("conn.open");
  // p2p-log.ts: "connect.error peer ms err   a dial failed". This dial did not fail.
  expect(dialer).not.toContain("connect.error");
}, 20_000);
