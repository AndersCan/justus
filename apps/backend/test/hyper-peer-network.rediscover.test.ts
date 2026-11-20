import { afterEach, expect, it } from "vite-plus/test";
import createTestnet from "hyperdht/testnet";
import { createHyperPeerNetwork } from "../src/adapters/hyper-peer-network.ts";
import type { PeerEvent } from "../src/ports/peer-network.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function phone(bootstrap: string[]) {
  const network = createHyperPeerNetwork({ bootstrap, replicate: () => {} });
  const connected = new Promise<void>((resolve) =>
    network.start("a".repeat(64), (e: PeerEvent) => e.type === "connected" && resolve(), 1),
  );
  cleanups.push(() => network.close());
  return { network, connected };
}

it("keeps looking when the first peer was a dead connection: the lookup starts again once it is gone", async () => {
  const net = await createTestnet(5);
  cleanups.push(() => net.destroy());
  const client = phone(net.bootstrap);
  const server = phone(net.bootstrap);
  const topic = "c".repeat(64);
  client.network.join(topic, { server: false });
  // The drive reports a peer for the first 1.5 s: a connection to a restarted phone's old key,
  // not yet timed out. The restarted phone announces after that.
  const staleUntil = Date.now() + 1500;
  client.network.findPeers(
    topic,
    () => Date.now() < staleUntil || client.network.connectionCount() > 0,
  );
  await new Promise((r) => setTimeout(r, 2000));
  server.network.join(topic, { server: true });
  await Promise.race([
    Promise.all([client.connected, server.connected]),
    new Promise((_, reject) => setTimeout(() => reject(new Error("no connection")), 15_000)),
  ]);
  expect(client.network.connectionCount()).toBeGreaterThan(0);
}, 30_000);
