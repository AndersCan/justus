/**
 * The PeerNetwork contract (#200): behaviour of Hyperswarm and the identity
 * greeting that the app relies on, written once and run against every
 * implementation.
 *
 * Portable on purpose: no test-runner or Node built-in imports, so esbuild can bundle
 * it for Bare. A runtime supplies a {@link PeerWorld} and a `Check`.
 */
import { parseAnswer } from "../../src/membership/records.ts";
import type { PeerEvent, PeerNetwork } from "../../src/ports/peer-network.ts";
import { PEER_PROTOCOL } from "../../src/versions.ts";
import { eventually, type Check } from "../p2p-scenarios.ts";

export type PeerNode = {
  /** The current network; replaced by {@link PeerNode.restart}. Already started. */
  readonly network: PeerNetwork;
  /** The identity drive key this node greets with. Stable across restarts. */
  readonly identityKey: string;
  /** Every event the node's networks reported, in order. */
  readonly events: PeerEvent[];
  /** Closes the network and starts a new one with the same identity. */
  restart(): Promise<PeerNetwork>;
};

export type PeerWorld = {
  /** A started node with no joined topics. */
  node(opts?: { legacy?: boolean }): Promise<PeerNode>;
  /** A fresh random topic (64 hex chars). */
  topic(): string;
  close(): Promise<void>;
};

export type PeerCase = {
  name: string;
  run(world: PeerWorld, t: Check): Promise<void>;
};

const connected = (n: PeerNode) => n.events.flatMap((e) => (e.type === "connected" ? [e] : []));
const identified = (n: PeerNode) => n.events.flatMap((e) => (e.type === "identified" ? [e] : []));
const disconnected = (n: PeerNode) =>
  n.events.flatMap((e) => (e.type === "disconnected" ? [e] : []));

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The newest connection to `peerKey` with no later `disconnected` for the same conn. */
function liveConn(n: PeerNode, peerKey: string): number | undefined {
  const closed = new Set(disconnected(n).map((e) => e.conn));
  return connected(n)
    .filter((e) => e.peerKey === peerKey && !closed.has(e.conn))
    .at(-1)?.conn;
}

/** Values of `answer` events whose connection went to `peerKey`. */
function answersFrom(n: PeerNode, peerKey: string): unknown[] {
  const conns = new Set(connected(n).flatMap((e) => (e.peerKey === peerKey ? [e.conn] : [])));
  return n.events.flatMap((e) => (e.type === "answer" && conns.has(e.conn) ? [e.value] : []));
}

/** Connections with both a `version` and an `identified` event; a doomed duplicate dial has fewer. */
function bothEvents(n: PeerNode): number[] {
  const conns = (type: PeerEvent["type"]) =>
    new Set(n.events.flatMap((e) => (e.type === type ? [e.conn] : [])));
  const versions = conns("version");
  return [...conns("identified")].filter((c) => versions.has(c));
}

async function seesPeer(n: PeerNode, peerKey: string, ms = 10_000) {
  await eventually(
    async () => connected(n).map((e) => e.peerKey),
    (keys) => keys.includes(peerKey),
    `connected ${peerKey.slice(0, 8)}`,
    ms,
  );
}

/** Both serve the topic. Neither knows when the other has announced, so both keep looking. */
function meet(a: PeerNode, b: PeerNode, topic: string) {
  for (const n of [a, b]) {
    n.network.join(topic, { server: true });
    n.network.findPeers(topic, () => n.network.connectionCount() > 0);
  }
}

export const cases: PeerCase[] = [
  {
    name: "N1 connected reports the other node's per-boot peer key, not its identity key",
    async run(world, t) {
      const a = await world.node();
      const b = await world.node();
      const topic = world.topic();
      meet(a, b, topic);
      await seesPeer(a, b.network.peerKey());
      await seesPeer(b, a.network.peerKey());
      t.ok(a.network.peerKey() !== a.identityKey, "own peer key differs from identity key");
      t.ok(
        !connected(a).some((e) => e.peerKey === b.identityKey),
        "peer key is not the identity key",
      );
    },
  },
  {
    name: "N2 identified carries the other node's identity key on the same connection",
    async run(world, t) {
      const a = await world.node();
      const b = await world.node();
      const topic = world.topic();
      meet(a, b, topic);
      await eventually(
        async () => identified(a).map((e) => e.identityKey),
        (keys) => keys.includes(b.identityKey),
        "a identified b",
        10_000,
      );
      await eventually(
        async () => identified(b).map((e) => e.identityKey),
        (keys) => keys.includes(a.identityKey),
        "b identified a",
        10_000,
      );
      const greeting = identified(a).find((e) => e.identityKey === b.identityKey);
      const conn = connected(a).find((e) => e.conn === greeting?.conn);
      t.eq(conn?.peerKey, b.network.peerKey(), "identified conn is the connection to b");
    },
  },
  {
    name: "N3 a topic joined client-only and then as server is found by a third node",
    async run(world, t) {
      const a = await world.node();
      const c = await world.node();
      const topic = world.topic();
      a.network.join(topic, { server: false });
      a.network.join(topic, { server: true });
      c.network.join(topic, { server: false });
      c.network.findPeers(topic, () => c.network.connectionCount() > 0);
      await seesPeer(c, a.network.peerKey());
      t.ok(true, "found");
    },
  },
  {
    name: "N4 a client that joined before the server announced finds it within 5s through findPeers",
    async run(world, t) {
      const client = await world.node();
      const server = await world.node();
      const topic = world.topic();
      client.network.join(topic, { server: false });
      client.network.findPeers(topic, () => client.network.connectionCount() > 0);
      await new Promise<void>((r) => setTimeout(r, 200));
      server.network.join(topic, { server: true });
      const start = Date.now();
      await seesPeer(client, server.network.peerKey(), 5_000);
      t.ok(Date.now() - start < 5_000, "found within 5s");
    },
  },
  {
    name: "N8 two servers joining the same topic at once find each other within 15s",
    async run(world, t) {
      const a = await world.node();
      const b = await world.node();
      const topic = world.topic();
      meet(a, b, topic);
      await seesPeer(a, b.network.peerKey(), 15_000);
      await seesPeer(b, a.network.peerKey(), 15_000);
      t.ok(a.network.connectionCount() > 0 && b.network.connectionCount() > 0, "both connected");
    },
  },
  {
    name: "N5 peer key differs after a restart",
    async run(world, t) {
      const a = await world.node();
      const before = a.network.peerKey();
      const network = await a.restart();
      t.ok(network.peerKey() !== before, "peer key changed");
      t.ok(network.peerKey() !== a.identityKey, "peer key is not the identity key");
    },
  },
  {
    name: "N6 closing a peer reports disconnected and the connection count drops",
    async run(world, t) {
      const a = await world.node();
      const b = await world.node();
      const topic = world.topic();
      meet(a, b, topic);
      await seesPeer(a, b.network.peerKey());
      t.eq(a.network.connectionCount(), 1, "one connection");
      const bKey = b.network.peerKey();
      await b.network.close();
      await eventually(
        async () => disconnected(a).map((e) => e.peerKey),
        (keys) => keys.includes(bKey),
        "disconnected",
        10_000,
      );
      await eventually(
        async () => a.network.connectionCount(),
        (n) => n === 0,
        "connection count back to 0",
        5_000,
      );
    },
  },
  {
    name: "N7 join twice adds one join; leave is idempotent; close releases everything",
    async run(world, t) {
      const a = await world.node();
      const topic = world.topic();
      function joins(): number {
        const list = a.network.debug().joins;
        return Array.isArray(list) ? list.length : -1;
      }
      a.network.join(topic, { server: true });
      a.network.join(topic, { server: true });
      t.eq(joins(), 1, "one join after joining twice");
      a.network.leave(topic);
      a.network.leave(topic);
      t.eq(joins(), 0, "no joins after leaving");
      a.network.join(topic, { server: false });
      a.network.join(world.topic(), { server: true });
      t.eq(joins(), 2, "two topics joined");
      await a.network.close();
      t.eq(joins(), 0, "close released every join");
      t.eq(a.network.connectionCount(), 0, "no connections after close");
    },
  },
  {
    name: "N9 closing right after joining never reports disconnected without connected",
    async run(world, t) {
      const a = await world.node();
      const b = await world.node();
      const topic = world.topic();
      meet(a, b, topic);
      await b.network.close();
      await new Promise((r) => setTimeout(r, 500));
      for (const n of [a, b]) {
        const seen = new Set<string>();
        let ok = true;
        for (const e of n.events) {
          if (e.type === "connected") seen.add(e.peerKey);
          if (e.type === "disconnected" && !seen.has(e.peerKey)) ok = false;
        }
        t.ok(ok, "every disconnected follows a connected for the same peer");
      }
    },
  },
  {
    name: "N10 an answer travels both ways on one connection and arrives on its sender's connection",
    async run(world, t) {
      const a = await world.node();
      const b = await world.node();
      meet(a, b, world.topic());
      await eventually(
        async () => [liveConn(a, b.network.peerKey()), liveConn(b, a.network.peerKey())],
        (conns) => conns.every((c) => c !== undefined),
        "live connection both ways",
        10_000,
      );
      const accepted = { code: "ab".repeat(32), answer: "accepted", shareKey: "cd".repeat(32) };
      const declined = { code: "ab".repeat(32), answer: "declined" };
      // A dial dropped as a duplicate loses what it carried, so keep sending until it lands.
      const sendUntilReceived = (
        from: PeerNode,
        to: PeerNode,
        message: typeof accepted | typeof declined,
      ) =>
        eventually(
          async () => {
            const conn = liveConn(from, to.network.peerKey());
            if (conn !== undefined) from.network.sendAnswer(conn, message);
            await sleep(200);
            return answersFrom(to, from.network.peerKey());
          },
          (got) => got.length > 0,
          "answer received",
          10_000,
        );
      const atB = await sendUntilReceived(a, b, accepted);
      const atA = await sendUntilReceived(b, a, declined);
      t.eq(parseAnswer(atB[0]), accepted, "b read a's accepted answer");
      t.eq(parseAnswer(atA[0]), declined, "a read b's declined answer");
    },
  },
  {
    name: "N11 a server that joins a topic later still meets the one already waiting",
    async run(world, t) {
      const x = await world.node();
      const y = await world.node();
      const topic = world.topic();
      x.network.join(topic, { server: true });
      await sleep(3_000);
      y.network.join(topic, { server: true });
      await seesPeer(x, y.network.peerKey(), 10_000);
      t.ok(true, "x and y connected within 10s");
    },
  },
  {
    name: "N12 version arrives before identified on every connection, 20 connections",
    async run(world, t) {
      for (let round = 0; round < 4; round++) {
        await Promise.all(
          Array.from({ length: 5 }, async (_, i) => {
            const a = await world.node();
            const b = await world.node();
            meet(a, b, world.topic());
            for (const node of [a, b]) {
              await eventually(
                async () => bothEvents(node).length,
                (n) => n >= 1,
                "version and identified",
                10_000,
              );
              for (const conn of bothEvents(node)) {
                const order = node.events.flatMap((e) =>
                  e.conn === conn && (e.type === "version" || e.type === "identified")
                    ? [e.type]
                    : [],
                );
                t.eq(order[0], "version", `round ${round} pair ${i}: version first`);
                const version = node.events.find((e) => e.type === "version" && e.conn === conn);
                t.eq(
                  version?.type === "version" ? version.protocol : undefined,
                  PEER_PROTOCOL,
                  `round ${round} pair ${i}: protocol`,
                );
              }
            }
          }),
        );
      }
    },
  },
  {
    name: "N13 a protocol 1 peer delivers identified and never a version",
    async run(world, t) {
      const newer = await world.node();
      const older = await world.node({ legacy: true });
      meet(newer, older, world.topic());
      const greeting = await eventually(
        async () => identified(newer).find((e) => e.identityKey === older.identityKey),
        (e) => e !== undefined,
        "identified from the older peer",
        10_000,
      );
      await sleep(2_000);
      t.ok(
        !newer.events.some((e) => e.type === "version" && e.conn === greeting?.conn),
        "newer side got no version on that connection",
      );
      t.ok(!older.events.some((e) => e.type === "version"), "older side got no version");
    },
  },
];
