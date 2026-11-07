/**
 * Assumptions behind the version exchange, pinned against the real libraries:
 * A5 a peer that opens `justus/version` before `justus/identity/v1` has its
 * version delivered before its identity greeting, on every connection; A6 a
 * protocol 1 peer (greeting only) never delivers a version.
 *
 * Portable: no test-runner or Node built-in imports, so esbuild can bundle it
 * for Bare. A runtime supplies a {@link VersionWorld} and a `Check`.
 */
import { eventually, type Check } from "../p2p-scenarios.ts";

export type VersionConn = {
  /** The remote side's swarm (noise) key, hex. */
  readonly remoteKey: string;
  /** `version:<n>` and `identity`, in arrival order. */
  readonly events: string[];
  destroy(): void;
};

export type VersionNode = {
  swarmKey(): string;
  /** Live connections. */
  readonly conns: VersionConn[];
  join(topic: string): void;
  close(): Promise<void>;
};

export type VersionWorld = {
  /** `own` is the protocol number sent; null is a protocol 1 peer. */
  node(own: number | null): Promise<VersionNode>;
  topic(): string;
  close(): Promise<void>;
};

export type VersionCase = {
  name: string;
  run(world: VersionWorld, t: Check): Promise<void>;
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function connectedTo(a: VersionNode, b: VersionNode, ms = 10_000) {
  await eventually(
    async () => a.conns.some((c) => c.remoteKey === b.swarmKey()),
    Boolean,
    "connection",
    ms,
  );
  return a.conns.find((c) => c.remoteKey === b.swarmKey())!;
}

export const cases: VersionCase[] = [
  {
    name: "A5 version arrives before identity on both sides, 20 connections in a row",
    async run(world, t) {
      for (let i = 0; i < 20; i++) {
        const a = await world.node(2);
        const b = await world.node(2);
        const topic = world.topic();
        a.join(topic);
        b.join(topic);
        await Promise.all([connectedTo(a, b), connectedTo(b, a)]);
        for (const node of [a, b]) {
          // Hyperswarm may briefly hold a second, doomed connection from a simultaneous dial.
          await eventually(
            async () => node.conns.filter((c) => c.events.length >= 2).length,
            (n) => n >= 1,
            "version and identity",
            10_000,
          );
          t.ok(
            node.conns.every((c) => c.events[0] !== "identity"),
            "identity came first",
          );
          for (const conn of node.conns)
            if (conn.events.length >= 2)
              t.eq(conn.events, ["version:2", "identity"], `connection ${i}`);
        }
        await a.close();
        await b.close();
      }
    },
  },
  {
    name: "A6 a protocol 1 peer delivers identity and never a version",
    async run(world, t) {
      const newer = await world.node(2);
      const older = await world.node(null);
      const topic = world.topic();
      newer.join(topic);
      older.join(topic);
      const seenByNewer = await connectedTo(newer, older);
      const seenByOlder = await connectedTo(older, newer);
      await eventually(
        async () => seenByNewer.events.includes("identity"),
        Boolean,
        "identity from the older peer",
        10_000,
      );
      await sleep(2_000);
      t.eq(seenByNewer.events, ["identity"], "newer side events");
      t.ok(!seenByOlder.events.some((e) => e.startsWith("version")), "older side got no version");
    },
  },
];
