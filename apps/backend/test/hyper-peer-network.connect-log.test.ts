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
}, 20_000);
