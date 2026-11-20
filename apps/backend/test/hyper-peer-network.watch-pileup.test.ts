import { afterEach, expect, it } from "vite-plus/test";
import createTestnet from "hyperdht/testnet";
import { createHyperPeerNetwork } from "../src/adapters/hyper-peer-network.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

it("a topic looked up three times while it has a peer keeps one watch at most, not three", async () => {
  const net = await createTestnet(3);
  cleanups.push(() => net.destroy());
  const network = createHyperPeerNetwork({
    bootstrap: net.bootstrap,
    replicate: () => {},
    log: () => {},
  } as any);
  cleanups.push(() => network.close());
  const topic = "d".repeat(64);
  network.join(topic, { server: false });
  let checks = 0;
  const hasPeer = () => (checks++, true);
  for (let i = 0; i < 3; i++) network.findPeers(topic, hasPeer);
  await new Promise((r) => setTimeout(r, 11_500));
  console.log("timers", network.debug().rediscoverTimers, "checks", checks);
  expect(network.debug().rediscoverTimers).toBeLessThanOrEqual(1);
}, 30_000);

it("leave(topic) ends the watch", async () => {
  const net = await createTestnet(3);
  cleanups.push(() => net.destroy());
  const network = createHyperPeerNetwork({
    bootstrap: net.bootstrap,
    replicate: () => {},
    log: () => {},
  } as any);
  cleanups.push(() => network.close());
  const topic = "e".repeat(64);
  network.join(topic, { server: false });
  network.findPeers(topic, () => true);
  expect(network.debug().rediscoverTimers).toBe(1);
  network.leave(topic);
  expect(network.debug().rediscoverTimers).toBe(0);
});
