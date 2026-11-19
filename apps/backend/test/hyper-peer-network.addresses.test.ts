import { networkInterfaces } from "node:os";
import { afterEach, expect, it } from "vite-plus/test";
import createTestnet from "hyperdht/testnet";
import { createHyperPeerNetwork } from "../src/adapters/hyper-peer-network.ts";
import type { PeerEvent, PeerNetwork } from "../src/ports/peer-network.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function phone(bootstrap: string[], recordAddresses: boolean) {
  const network = createHyperPeerNetwork({ bootstrap, recordAddresses, replicate: () => {} });
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

type Addresses = {
  bound: Record<string, number>;
  sent: Record<string, number>;
  streams: Record<string, number>;
};
const addressesOf = (n: PeerNetwork) => n.debug().addresses as Addresses | undefined;
const portOf = (address: string) => address.slice(address.lastIndexOf(":") + 1);

it("lists the addresses two phones used: sockets bound, hosts sent to, and the far end of the connection", async () => {
  const net = await createTestnet(5);
  cleanups.push(() => net.destroy());
  const a = phone(net.bootstrap, true);
  const b = phone(net.bootstrap, true);
  const topic = "b".repeat(64);
  a.network.join(topic, { server: true });
  b.network.join(topic, { server: false });
  b.network.findPeers(topic, () => false);
  await Promise.race([
    Promise.all([a.connected, b.connected]),
    new Promise((_, reject) => setTimeout(() => reject(new Error("no connection")), 10_000)),
  ]);

  const own = new Set(
    Object.values(networkInterfaces())
      .flat()
      .map((i) => i?.address),
  );
  const logs = [addressesOf(a.network)!, addressesOf(b.network)!];
  for (const log of logs) {
    expect(Object.keys(log.bound).length).toBeGreaterThan(0);
    for (const sent of Object.keys(log.sent)) {
      expect(own.has(sent.slice(0, sent.lastIndexOf(":")))).toBe(true);
    }
  }
  const bound = (log: Addresses) => new Set(Object.keys(log.bound).map(portOf));
  expect(Object.keys(logs[0]!.streams).length).toBeGreaterThan(0);
  for (const stream of Object.keys(logs[0]!.streams))
    expect(bound(logs[1]!).has(portOf(stream))).toBe(true);
  for (const stream of Object.keys(logs[1]!.streams))
    expect(bound(logs[0]!).has(portOf(stream))).toBe(true);
}, 20_000);

it("has no address log unless asked", async () => {
  const net = await createTestnet(3);
  cleanups.push(() => net.destroy());
  const a = phone(net.bootstrap, false);
  expect(addressesOf(a.network)).toBeUndefined();
});
