/**
 * Builds {@link VersionNode}s from the real Corestore and Hyperswarm. Portable
 * (no Node built-ins) so the Node and Bare runners share it.
 */
import { greetPeer } from "../src/adapters/peer-identity.ts";
import { openVersion } from "../src/adapters/peer-version.ts";
import type { VersionConn, VersionNode } from "./contracts/peer-version.contract.ts";

type Libs = {
  Corestore: new (dir: string) => any;
  Hyperswarm: new (opts: { bootstrap: string[] }) => any;
  bootstrap: string[];
};

/** Same backoff as `findPeers` in hyper-peer-network. */
const REDISCOVER_MS = [500, 1000, 2000, 4000, 8000, 15000];

const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/** `own` null speaks protocol 1: identity greeting only. */
export function makeVersionNode(libs: Libs, dir: string, own: number | null): VersionNode {
  const store = new libs.Corestore(dir);
  const swarm = new libs.Hyperswarm({ bootstrap: libs.bootstrap });
  const identity = Buffer.alloc(32, own ?? 1);
  const conns: VersionConn[] = [];
  const everSeen = new Set<string>();
  swarm.on("connection", (conn: any) => {
    store.replicate(conn);
    const entry: VersionConn = {
      remoteKey: toHex(conn.remotePublicKey),
      events: [],
      destroy: () => conn.destroy(),
    };
    conns.push(entry);
    everSeen.add(entry.remoteKey);
    if (own !== null) openVersion(conn, own, (v) => entry.events.push(`version:${v}`));
    greetPeer(conn, identity, () => entry.events.push("identity"));
    conn.on("error", () => {});
    conn.on("close", () => {
      const i = conns.indexOf(entry);
      if (i >= 0) conns.splice(i, 1);
    });
  });
  return {
    swarmKey: () => toHex(swarm.keyPair.publicKey),
    conns,
    join(topic) {
      const t = Buffer.from(topic, "hex");
      swarm.join(t, { server: true, client: true });
      let n = 0;
      const tick = () => {
        if (swarm.destroyed || swarm.connections.size > 0 || n >= REDISCOVER_MS.length) return;
        swarm.status(t)?.refresh();
        setTimeout(tick, REDISCOVER_MS[n++]);
      };
      setTimeout(tick, REDISCOVER_MS[n++]);
    },
    async close() {
      await swarm.destroy();
      await store.close();
    },
  };
}
