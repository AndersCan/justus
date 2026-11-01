/**
 * The harness DHT (`scripts/local-dht.mjs`) behind the two-process e2e hub.
 *
 * A joiner's holepunch only works when the album creator's NAT analysis is
 * stable, which needs 3+ routing-table nodes to sample. A peer's table never
 * holds the bootstrap node, so a 3-node net left an idle creator with 2 nodes:
 * its server aborted every holepunch and the joiner's stream timed out (#200).
 */
import { afterEach, expect, it } from "vite-plus/test";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import Hyperswarm from "hyperswarm";

const script = fileURLToPath(new URL("../scripts/local-dht.mjs", import.meta.url));
const PORT = 49837;

let dht: ChildProcess | undefined;
let swarm:
  | {
      dht: { nodes: { length: number }; fullyBootstrapped(): Promise<void> };
      destroy(): Promise<void>;
    }
  | undefined;

afterEach(async () => {
  await swarm?.destroy();
  dht?.kill("SIGKILL");
  swarm = dht = undefined;
});

it("gives an idle peer enough routing-table nodes for a stable NAT analysis", async () => {
  dht = spawn(process.execPath, [script, String(PORT)], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((resolve, reject) => {
    dht!.once("error", reject);
    dht!.stdout!.on("data", (d: Buffer) => {
      if (String(d).includes("local DHT bootstrap bound")) resolve();
    });
  });

  const s = new Hyperswarm({ bootstrap: [`127.0.0.1:${PORT}`] }) as unknown as NonNullable<
    typeof swarm
  >;
  swarm = s;
  await s.dht.fullyBootstrapped();
  // Never joined a topic: the state of a creator that is idle since boot.
  expect(s.dht.nodes.length).toBeGreaterThanOrEqual(3);
}, 30_000);
