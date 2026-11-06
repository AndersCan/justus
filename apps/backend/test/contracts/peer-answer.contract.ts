/**
 * Assumptions behind private sharing, pinned against the real libraries:
 * A1 an invite-topic peer cannot read the album, A2 the answer channel carries
 * a message tied to the connection, A3 a restarted peer's `/device.json`
 * is readable under its new key, A4 two servers that join a topic at different
 * times still meet.
 *
 * Portable: no test-runner or Node built-in imports, so esbuild can bundle it
 * for Bare. A runtime supplies an {@link AnswerWorld} and a `Check`.
 */
import { parseAnswer, type Answer } from "../../src/membership/records.ts";
import { eventually, type Check } from "../p2p-scenarios.ts";

export type AnswerConn = {
  /** The remote side's swarm (noise) key, hex. */
  readonly remoteKey: string;
  /** Raw values received on the answer channel, in order. */
  readonly received: unknown[];
  send(answer: Answer): boolean;
};

export type AnswerNode = {
  /** This node's current swarm key, hex. Changes on {@link AnswerNode.restart}. */
  swarmKey(): string;
  /** Every connection this node accepted, with the answer channel open on it. */
  readonly conns: AnswerConn[];
  /** Creates a drive in this node's corestore under `name`. */
  drive(name: string): Promise<AnswerDrive>;
  /** Opens another node's drive by key. */
  open(key: string): Promise<AnswerDrive>;
  /** Whether this node's store holds a core with this discovery key (hex). */
  hasCore(discoveryKey: string): Promise<boolean>;
  /** `rediscover` refreshes the lookup with the production backoff until a peer connects. */
  join(topic: string, opts: { server: boolean; rediscover?: boolean }): void;
  /** Closes swarm and store, then opens new ones on the same storage with a new swarm key. */
  restart(): Promise<void>;
  close(): Promise<void>;
};

export type AnswerDrive = {
  readonly key: string;
  readonly discoveryKey: string;
  put(path: string, text: string): Promise<void>;
  /** `get` alone, without `update()`. Resolves null when nothing is there yet. */
  get(path: string): Promise<string | null>;
  update(): Promise<void>;
  /** Replication peers the drive's core has, one per connection that opened it. */
  corePeers(): number;
};

export type AnswerWorld = {
  node(): Promise<AnswerNode>;
  topic(): string;
  close(): Promise<void>;
};

export type AnswerCase = {
  name: string;
  run(world: AnswerWorld, t: Check): Promise<void>;
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function connectedTo(a: AnswerNode, b: AnswerNode, ms = 10_000) {
  await eventually(
    async () => a.conns.some((c) => c.remoteKey === b.swarmKey()),
    Boolean,
    "connection",
    ms,
  );
  return a.conns.find((c) => c.remoteKey === b.swarmKey())!;
}

const hex = (n: number) => "ab".repeat(n);

export const cases: AnswerCase[] = [
  {
    name: "A1 a peer that met the owner only on an invite topic cannot replicate the album",
    async run(world, t) {
      const owner = await world.node();
      const stranger = await world.node();
      const album = await owner.drive("album");
      await album.put("/photos/a.txt", "secret");
      const invite = world.topic();
      owner.join(invite, { server: true, rediscover: true });
      stranger.join(invite, { server: true, rediscover: true });
      await connectedTo(owner, stranger);
      await sleep(2_000);
      // hypercore replicator.js onopen: a remote needs caps.replicate(core.key, ...).
      t.eq(album.corePeers(), 0, "owner's album core has no replication peer");
      t.ok(
        !(await stranger.hasCore(album.discoveryKey)),
        "stranger's store holds no core with the album key",
      );
    },
  },
  {
    name: "A2 an answer travels both ways on a connection and is tied to its swarm key",
    async run(world, t) {
      const a = await world.node();
      const b = await world.node();
      const topic = world.topic();
      a.join(topic, { server: true, rediscover: true });
      b.join(topic, { server: true, rediscover: true });
      const accepted: Answer = { code: hex(32), answer: "accepted", shareKey: "cd".repeat(32) };
      const declined: Answer = { code: hex(32), answer: "declined" };
      await connectedTo(a, b);
      await connectedTo(b, a);
      // A dial that Hyperswarm drops as a duplicate loses what it carried, so keep sending until it lands.
      const landed = (n: AnswerNode, from: AnswerNode) =>
        n.conns.flatMap((c) => (c.remoteKey === from.swarmKey() ? c.received : []));
      const sendUntilReceived = (from: AnswerNode, to: AnswerNode, answer: Answer) =>
        eventually(
          async () => {
            from.conns.find((c) => c.remoteKey === to.swarmKey())?.send(answer);
            await sleep(200);
            return landed(to, from).map(parseAnswer);
          },
          (got) => got.length > 0,
          "answer received",
          10_000,
        );
      const atB = await sendUntilReceived(a, b, accepted);
      const atA = await sendUntilReceived(b, a, declined);
      t.eq(atB[0], accepted, "b read a's accepted answer");
      t.eq(atA[0], declined, "a read b's declined answer");
      // Both are looked up by the sender's swarm key: the receiver knows who sent it.
      t.ok(
        b.conns.some((c) => c.remoteKey === a.swarmKey() && c.received.length > 0),
        "b ties it to a's swarm key",
      );
      t.ok(
        a.conns.some((c) => c.remoteKey === b.swarmKey() && c.received.length > 0),
        "a ties it to b's swarm key",
      );
    },
  },
  {
    name: "A3 after a restart the new swarm key is readable on the identity drive",
    async run(world, t) {
      const reader = await world.node();
      const peer = await world.node();
      const identity = await peer.drive("identity");
      await identity.put("/device.json", JSON.stringify({ swarmKey: peer.swarmKey() }));
      const topic = world.topic();
      reader.join(topic, { server: true, rediscover: true });
      peer.join(topic, { server: true, rediscover: true });
      await connectedTo(reader, peer);
      const view = await reader.open(identity.key);
      await view.update();
      const first = await eventually(
        async () => view.get("/device.json"),
        (v) => v !== null,
        "first read",
        10_000,
      );
      t.eq(JSON.parse(first!).swarmKey, peer.swarmKey(), "first key matches");

      const oldKey = peer.swarmKey();
      await peer.restart();
      t.ok(peer.swarmKey() !== oldKey, "restart changed the swarm key");
      const again = await peer.drive("identity");
      await again.put("/device.json", JSON.stringify({ swarmKey: peer.swarmKey() }));
      peer.join(topic, { server: true, rediscover: true });
      await eventually(
        async () => reader.conns.some((c) => c.remoteKey === peer.swarmKey()),
        Boolean,
        "reconnect",
        10_000,
      );
      const read = async () => JSON.parse((await view.get("/device.json")) ?? "{}").swarmKey;
      const viaGet = await eventually(read, (k) => k === peer.swarmKey(), "get alone", 5_000).then(
        () => true,
        () => false,
      );
      if (!viaGet) {
        await view.update();
        await eventually(read, (k) => k === peer.swarmKey(), "get after update", 5_000);
      }
      t.eq(await read(), peer.swarmKey(), "reader sees the new swarm key within 5s");
    },
  },
  {
    name: "A4 a server that joins a topic later still meets the one already waiting",
    async run(world, t) {
      const x = await world.node();
      const y = await world.node();
      const topic = world.topic();
      x.join(topic, { server: true });
      await sleep(3_000);
      y.join(topic, { server: true });
      const seen = await connectedTo(x, y, 10_000);
      t.ok(seen !== undefined, "x and y connected within 10s");
    },
  },
];
