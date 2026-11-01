import { errText, short, createP2pLog, type P2pLog } from "../p2p-log";
import type { PeerEvent, PeerNetwork } from "../ports/peer-network";
import { greetPeer } from "./peer-identity";
import Hyperswarm from "hyperswarm";

type Handle = { destroy(): void | Promise<void>; flushed?: () => Promise<void> };

/** Backoff for `findPeers`: about two minutes in all, after which Hyperswarm's own 10-minute refresh takes over. */
const REDISCOVER_MS = [500, 1000, 2000, 4000, 8000, 15000, 30000, 60000];

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

export function createHyperPeerNetwork(deps: {
  bootstrap?: string[];
  /** Replicates the drive store over a connection (the store adapter's `replicate`). */
  replicate(conn: unknown): unknown;
  log?: P2pLog;
}): PeerNetwork {
  const log = deps.log ?? createP2pLog();
  const swarm: any = new Hyperswarm(deps.bootstrap ? { bootstrap: deps.bootstrap } : undefined);
  const joins = new Map<string, Handle>();
  const servedTopics = new Set<string>();
  /** Later joins of a topic that upgraded it to serving; left with it. */
  const extraJoins = new Map<string, Handle[]>();
  const rediscoverTimers = new Set<ReturnType<typeof setTimeout>>();
  const peerIdentities = new Set<string>();
  const conns = new Map<
    number,
    { noiseKey?: string; identityKey?: string; openedAt: number; initiator?: boolean }
  >();
  let connSeq = 0;
  let ownIdentity = "";
  let closed = false;

  function logLeave(topic: string) {
    return (e: unknown) =>
      log("error", { where: "topic.leave", topic: short(topic), err: errText(e) });
  }

  function destroyHandle(topic: string, handle: Handle) {
    try {
      const result = handle.destroy();
      /** `destroy` may return a promise; swallow a rejection so leaving a topic can't raise an unhandled rejection. */
      if (result instanceof Promise) result.catch(logLeave(topic));
    } catch {
      // already destroyed (sync throw on teardown): expected, quiet
    }
  }

  function onConnection(conn: any, emit: (e: PeerEvent) => void) {
    const connId = ++connSeq;
    const noiseKey = Buffer.isBuffer(conn.remotePublicKey)
      ? toHex(conn.remotePublicKey)
      : undefined;
    const openedAt = Date.now();
    conns.set(connId, { noiseKey, openedAt, initiator: conn.isInitiator });
    log("conn.open", { conn: connId, noise: short(noiseKey), initiator: conn.isInitiator });
    conn.on("error", (e: unknown) =>
      log("conn.error", { conn: connId, noise: short(noiseKey), err: errText(e) }),
    );
    conn.on("close", () => {
      conns.delete(connId);
      log("conn.close", { conn: connId, noise: short(noiseKey), ms: Date.now() - openedAt });
      if (noiseKey) emit({ type: "disconnected", conn: connId, peerKey: noiseKey });
    });
    try {
      deps.replicate(conn);
    } catch (e: unknown) {
      log("error", { where: "replicate", conn: connId, err: errText(e) });
    }
    if (noiseKey) {
      emit({
        type: "connected",
        conn: connId,
        peerKey: noiseKey,
        initiator: Boolean(conn.isInitiator),
      });
    }
    try {
      greetPeer(conn, Buffer.from(ownIdentity, "hex"), (key) => {
        const identityKey = toHex(key);
        const isNew = !peerIdentities.has(identityKey) && identityKey !== ownIdentity;
        log("identity.learned", { conn: connId, identity: short(identityKey), new: isNew });
        const c = conns.get(connId);
        if (c) c.identityKey = identityKey;
        if (isNew) peerIdentities.add(identityKey);
        emit({ type: "identified", conn: connId, identityKey });
      });
    } catch (e: unknown) {
      log("error", { where: "identity.greet", conn: connId, err: errText(e) });
    }
  }

  function leave(topic: string) {
    const handle = joins.get(topic);
    if (!handle) return;
    joins.delete(topic);
    servedTopics.delete(topic);
    log("topic.leave", { topic: short(topic) });
    for (const extra of extraJoins.get(topic) ?? []) destroyHandle(topic, extra);
    extraJoins.delete(topic);
    destroyHandle(topic, handle);
  }

  return {
    peerKey() {
      return toHex(swarm.keyPair.publicKey);
    },
    start(identityKey, onEvent) {
      ownIdentity = identityKey;
      swarm.on("connection", (conn: any) => onConnection(conn, onEvent));
    },
    join(topic, opts) {
      if (closed) return;
      const existing = joins.get(topic);
      /** A topic first joined as a client only must still announce when a later caller asks to serve on it. Hyperswarm adds the second join as a session of the same discovery and re-announces. */
      if (existing && !(opts.server && !servedTopics.has(topic))) return;
      const handle: Handle = swarm.join(Buffer.from(topic, "hex"), {
        server: opts.server,
        client: true,
      });
      if (opts.server) servedTopics.add(topic);
      if (existing) {
        log("topic.upgrade", { topic: short(topic) });
        extraJoins.set(topic, [...(extraJoins.get(topic) ?? []), handle]);
        return;
      }
      joins.set(topic, handle);
      log("topic.join", { topic: short(topic), served: opts.server });
      // Fire-and-forget: never block setup on DHT bootstrap.
      const joinedAt = Date.now();
      void handle
        .flushed?.()
        .then(() => log("topic.flushed", { topic: short(topic), ms: Date.now() - joinedAt }))
        .catch((e) =>
          log("error", { where: "topic.flushed", topic: short(topic), err: errText(e) }),
        );
    },
    leave,
    findPeers(topic, hasPeer) {
      let attempt = 0;
      function tick() {
        rediscoverTimers.delete(timer);
        if (closed || hasPeer() || !joins.has(topic)) return;
        log("rediscover.attempt", { topic: short(topic), n: attempt + 1 });
        try {
          void Promise.resolve(swarm.status?.(Buffer.from(topic, "hex"))?.refresh()).catch((e) =>
            log("error", { where: "rediscover.refresh", topic: short(topic), err: errText(e) }),
          );
        } catch {
          // discovery gone (topic left meanwhile): expected, quiet
        }
        if (++attempt >= REDISCOVER_MS.length) {
          log("rediscover.giveup", { topic: short(topic) });
          return;
        }
        timer = setTimeout(tick, REDISCOVER_MS[attempt]);
        rediscoverTimers.add(timer);
      }
      let timer = setTimeout(tick, REDISCOVER_MS[0]);
      rediscoverTimers.add(timer);
    },
    connectionCount() {
      return swarm.connections.size;
    },
    debug() {
      return {
        swarmKey: toHex(swarm.keyPair.publicKey),
        swarmConnections: swarm.connections.size,
        connections: [...conns].map(([conn, c]) => ({
          conn,
          noiseKey: c.noiseKey ?? null,
          identityKey: c.identityKey ?? null,
          initiator: c.initiator ?? null,
          openedAt: c.openedAt,
        })),
        peerIdentities: [...peerIdentities],
        joins: [...joins.keys()].map((topic) => ({
          topic,
          served: servedTopics.has(topic),
          extraJoins: extraJoins.get(topic)?.length ?? 0,
        })),
        rediscoverTimers: rediscoverTimers.size,
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const timer of rediscoverTimers) clearTimeout(timer);
      rediscoverTimers.clear();
      for (const topic of joins.keys()) leave(topic);
      try {
        await swarm.destroy();
      } catch {
        // already closed
      }
    },
  };
}
