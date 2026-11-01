import createTestnet from "hyperdht/testnet.js";

/** Local DHT for deterministic dev/test (no public bootstrap).
 * Usage: node scripts/local-dht.mjs [port=49737]
 *
 * A 3-node testnet with its first node on `port`, as the real-swarm tests use
 * (`apps/backend/test/real-peers.ts`). A lone `HyperDHT.bootstrapper` is not
 * enough: it stores no announces, so two local peers never find each other
 * (#200). Prints "local DHT bootstrap bound to host:port" once ready;
 * scripts/e2e-hub.mjs waits for that line. */

const port = Number(process.argv[2]) || 49737;
const testnet = await createTestnet(3, { host: "127.0.0.1", port });
const addr = testnet.nodes[0].address();
console.log(`local DHT bootstrap bound to ${addr.host}:${addr.port}`);
const shutdown = () => {
  void testnet.destroy().then(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
