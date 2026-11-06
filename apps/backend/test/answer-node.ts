/**
 * Builds {@link AnswerNode}s from the real Corestore, Hyperdrive and Hyperswarm.
 * Portable (no Node built-ins) so the Node and Bare runners share it; each
 * passes its own constructors, storage directory and random source.
 */
import { openAnswers } from "../src/adapters/peer-answer.ts";
import type { AnswerConn, AnswerDrive, AnswerNode } from "./contracts/peer-answer.contract.ts";

type Libs = {
  Corestore: new (dir: string) => any;
  Hyperdrive: new (store: any, key?: Uint8Array) => any;
  Hyperswarm: new (opts: { bootstrap: string[] }) => any;
  bootstrap: string[];
};

/** Same backoff as `findPeers` in hyper-peer-network. */
const REDISCOVER_MS = [500, 1000, 2000, 4000, 8000, 15000];

const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const fromHex = (s: string) => Buffer.from(s, "hex");

export function makeAnswerNode(libs: Libs, dir: string): AnswerNode {
  let store: any;
  let swarm: any;
  const conns: AnswerConn[] = [];

  function boot() {
    store = new libs.Corestore(dir);
    swarm = new libs.Hyperswarm({ bootstrap: libs.bootstrap });
    swarm.on("connection", (conn: any) => {
      store.replicate(conn);
      const received: unknown[] = [];
      const answers = openAnswers(conn, (v) => received.push(v));
      conns.push({
        remoteKey: toHex(conn.remotePublicKey),
        received,
        send: (a) => answers.send(a),
      });
      const entry = conns[conns.length - 1]!;
      conn.on("error", () => {});
      // Hyperswarm closes one of two simultaneous dials; drop it so callers see live connections only.
      conn.on("close", () => {
        const i = conns.indexOf(entry);
        if (i >= 0) conns.splice(i, 1);
      });
    });
  }
  boot();

  const wrap = (drive: any): AnswerDrive => ({
    key: toHex(drive.key),
    discoveryKey: toHex(drive.core.discoveryKey),
    async put(path, text) {
      await drive.put(path, Buffer.from(text));
    },
    async get(path) {
      // Times out when the block has not replicated yet.
      const buf = await drive.get(path, { timeout: 1_500 }).catch(() => null);
      return buf ? Buffer.from(buf).toString() : null;
    },
    update: async () => {
      await drive.update({ wait: true });
    },
    corePeers: () => drive.core.peers.length,
  });

  return {
    swarmKey: () => toHex(swarm.keyPair.publicKey),
    conns,
    async drive(name) {
      const drive = new libs.Hyperdrive(store.namespace(name));
      await drive.ready();
      return wrap(drive);
    },
    async open(key) {
      const drive = new libs.Hyperdrive(store, fromHex(key));
      await drive.ready();
      return wrap(drive);
    },
    hasCore: (dk) => store.storage.hasCore(fromHex(dk)),
    join(topic, opts) {
      const t = fromHex(topic);
      const s = swarm;
      s.join(t, { server: opts.server, client: true });
      if (!opts.rediscover) return;
      let n = 0;
      const tick = () => {
        if (s !== swarm || s.connections.size > 0 || n >= REDISCOVER_MS.length) return;
        s.status(t)?.refresh();
        setTimeout(tick, REDISCOVER_MS[n++]);
      };
      setTimeout(tick, REDISCOVER_MS[n++]);
    },
    async close() {
      await swarm.destroy();
      await store.close();
    },
    async restart() {
      conns.length = 0;
      await swarm.destroy();
      await store.close();
      boot();
    },
  };
}
