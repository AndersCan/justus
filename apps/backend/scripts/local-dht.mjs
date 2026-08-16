import HyperDHT from "hyperdht";

/** Local DHT bootstrap node for deterministic dev/test (no public bootstrap).
 * Usage: node scripts/local-dht.mjs [port=49737] */

const port = Number(process.argv[2]) || 49737;
const node = HyperDHT.bootstrapper(port, "127.0.0.1");
await node.ready();
const addr = node.address();
console.log(`local DHT bootstrap bound to ${addr.host}:${addr.port}`);
const shutdown = () => {
  void node.destroy().then(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
