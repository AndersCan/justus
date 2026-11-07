/**
 * Drive store and peer network wired together as production wires them (#200):
 * each connection replicates the drives and carries the identity greeting on one
 * muxer. Checks what neither contract can alone: W1 an invite-topic peer cannot
 * replicate the album, W2 a restarted peer's `/device.json` is readable under its
 * new peer key.
 *
 * Portable: no test-runner or Node built-in imports, so esbuild can bundle it
 * for Bare. A runtime supplies a {@link WiredWorld} and a `Check`.
 */
import type { DriveStore } from "../../src/ports/drive-store.ts";
import type { PeerEvent, PeerNetwork } from "../../src/ports/peer-network.ts";
import { eventually, type Check } from "../p2p-scenarios.ts";

export type WiredNode = {
  readonly drives: DriveStore;
  /** The current network; replaced by {@link WiredNode.restart}. Already started. */
  readonly network: PeerNetwork;
  /** The identity drive key the node greets with. Stable across restarts. */
  readonly identityKey: string;
  /** Every event the node's networks reported, in order. */
  readonly events: PeerEvent[];
  /** Closes network and drives, then reopens both on the same storage and identity. */
  restart(): Promise<void>;
};

export type WiredWorld = {
  node(): Promise<WiredNode>;
  topic(): string;
  close(): Promise<void>;
};

export type WiredCase = {
  name: string;
  run(world: WiredWorld, t: Check): Promise<void>;
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Joins `topic` as a server and keeps looking until a connection exists. */
function meet(n: WiredNode, topic: string) {
  n.network.join(topic, { server: true });
  n.network.findPeers(topic, () => n.network.connectionCount() > 0);
}

async function connectedTo(n: WiredNode, peerKey: string, ms = 10_000) {
  await eventually(
    async () => n.events.some((e) => e.type === "connected" && e.peerKey === peerKey),
    Boolean,
    "connection",
    ms,
  );
}

export const cases: WiredCase[] = [
  {
    name: "W1 a peer that met the owner only on an invite topic cannot replicate the album",
    async run(world, t) {
      const owner = await world.node();
      const stranger = await world.node();
      const album = await owner.drives.openOwn("folder/album");
      await album.put("/photos/a.txt", Buffer.from("secret"));
      const invite = world.topic();
      meet(owner, invite);
      meet(stranger, invite);
      await connectedTo(owner, stranger.network.peerKey());
      await sleep(2_000);
      // hypercore replicator.js onopen: a remote needs caps.replicate(core.key, ...).
      // The old check that the stranger's store lacked the core read Corestore internals
      // (`store.storage.hasCore`), which the drive store port does not expose.
      t.eq(album.stats().peers, 0, "owner's album core has no replication peer");
    },
  },
  {
    name: "W2 after a restart the new peer key is readable on the identity drive",
    async run(world, t) {
      const reader = await world.node();
      const peer = await world.node();
      const idDrive = await peer.drives.openOwn();
      const write = (d: typeof idDrive) =>
        d.put("/device.json", Buffer.from(JSON.stringify({ swarmKey: peer.network.peerKey() })));
      await write(idDrive);
      const topic = world.topic();
      meet(reader, topic);
      meet(peer, topic);
      await connectedTo(reader, peer.network.peerKey());
      const [e, view] = await reader.drives.open(idDrive.key, { timeoutMs: 10_000 });
      if (e) throw e;
      await view.update();
      const read = async () => {
        const text = await view.readSmall("/device.json", 4096, { timeoutMs: 1_500 });
        return text === undefined ? undefined : (JSON.parse(text).swarmKey as string);
      };
      const first = await eventually(read, (k) => k !== undefined, "first read", 10_000);
      t.eq(first, peer.network.peerKey(), "first key matches");

      const oldKey = peer.network.peerKey();
      await peer.restart();
      const newKey = peer.network.peerKey();
      t.ok(newKey !== oldKey, "restart changed the peer key");
      const again = await peer.drives.openOwn();
      t.eq(again.key, idDrive.key, "identity drive key survives the restart");
      await write(again);
      meet(peer, topic);
      await connectedTo(reader, newKey);
      const viaRead = await eventually(read, (k) => k === newKey, "read alone", 5_000).then(
        () => true,
        () => false,
      );
      if (!viaRead) {
        await view.update();
        await eventually(read, (k) => k === newKey, "read after update", 5_000);
      }
      t.eq(await read(), newKey, "reader sees the new peer key within 5s");
    },
  },
];
