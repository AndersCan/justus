import Hyperswarm from "hyperswarm";

declare const Bare: { exit(code: number): void };

const topic = Buffer.alloc(32, 13);
const swarm = new Hyperswarm({ bootstrap: ["127.0.0.1:49737"] });
swarm.on("connection", () => {
  console.log(`[bare-swarm] CONNECTED peers=${swarm.connections.size}`);
});
swarm.on("connection-closed", () => {
  console.log(`[bare-swarm] CLOSED peers=${swarm.connections.size}`);
});
await swarm.join(topic, { server: true, client: true });
console.log("[bare-swarm] joined topic, waiting 15s...");
setTimeout(() => {
  console.log(`[bare-swarm] final peers=${swarm.connections.size}`);
  Bare.exit(0);
}, 15_000);
