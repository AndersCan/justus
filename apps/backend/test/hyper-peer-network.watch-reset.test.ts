import { afterEach, expect, it } from "vite-plus/test";
import createTestnet from "hyperdht/testnet";
import { createHyperPeerNetwork } from "../src/adapters/hyper-peer-network.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

it("a lost peer restarts the lookup from the first attempt, not where it stopped", async () => {
  const net = await createTestnet(3);
  cleanups.push(() => net.destroy());
  const attempts: number[] = [];
  const network = createHyperPeerNetwork({
    bootstrap: net.bootstrap,
    replicate: () => {},
    log: (event: string, data: { n?: number }) => {
      if (event === "rediscover.attempt") attempts.push(data.n ?? -1);
    },
  } as any);
  cleanups.push(() => network.close());
  const topic = "f".repeat(64);
  network.join(topic, { server: false });
  const start = Date.now();
  // No peer for two lookups (0.5 s, 1.5 s), a peer from 1.6 s to 7 s, then none.
  const hasPeer = () => {
    const t = Date.now() - start;
    return t > 1600 && t < 7000;
  };
  network.findPeers(topic, hasPeer);
  await new Promise((r) => setTimeout(r, 9_000));
  // Watch ticks at 3.5 s (peer) and 8.5 s (gone): that lookup is attempt 1 again.
  expect(attempts).toEqual([1, 2, 1]);
}, 30_000);

it("a repeat call restarts the backoff and replaces the check and info of the running lookup", async () => {
  const net = await createTestnet(3);
  cleanups.push(() => net.destroy());
  const seen: Array<{ n?: number; drive?: string }> = [];
  const network = createHyperPeerNetwork({
    bootstrap: net.bootstrap,
    replicate: () => {},
    log: (event: string, data: { n?: number; drive?: string }) => {
      if (event === "rediscover.attempt") seen.push(data);
    },
  } as any);
  cleanups.push(() => network.close());
  const topic = "a".repeat(64);
  network.join(topic, { server: false });
  network.findPeers(topic, () => false, { drive: "first" });
  await new Promise((r) => setTimeout(r, 2_000));
  expect(seen.map((s) => s.n)).toEqual([1, 2]);
  // A second caller replaces the check and info of the running lookup.
  let secondChecks = 0;
  network.findPeers(topic, () => (secondChecks++, false), { drive: "second" });
  await new Promise((r) => setTimeout(r, 2_000));
  // Next tick (3.5 s) is attempt 1 again, logged with the second caller's info.
  expect(seen[2]).toMatchObject({ n: 1, drive: "second" });
  expect(secondChecks).toBeGreaterThan(0);
}, 30_000);
