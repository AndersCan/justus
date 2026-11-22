import { errText, short, createP2pLog, type P2pLog } from "../p2p-log";
import type { ChannelMessage } from "../membership/records";
import type { PeerEvent, PeerNetwork } from "../ports/peer-network";
import { emptyAnswersIn, noteAnswerIn } from "./answers-in";
import { openAnswers } from "./peer-answer";
import { greetPeer } from "./peer-identity";
import { openVersion } from "./peer-version";
import { PEER_PROTOCOL } from "../versions";
import Hyperswarm from "hyperswarm";
import { emptyAddressLog, watchAddresses } from "./address-log";

type Handle = { destroy(): void | Promise<void>; flushed?: () => Promise<void> };

/** Backoff for `findPeers`: about two minutes in all, after which Hyperswarm's own 10-minute refresh takes over. */
const REDISCOVER_MS = [500, 1000, 2000, 4000, 8000, 15000, 30000, 60000];
/** While the drive has a peer, `findPeers` only watches: that peer may be a dead connection that has not timed out yet, and when it goes the lookups must start again. */
const WATCH_MS = 5000;

/** Debug lines for #2058: what the DHT did on the way to a connection, so a run where no phone connects names why. Only listens; Hyperswarm's behaviour is unchanged. */
function watchSwarm(swarm: any, log: P2pLog) {
  const dht = swarm.dht;
  const peersSeen = new Map<string, number>();
  const connect = dht.connect.bind(dht);
  dht.connect = (key: Uint8Array, ...rest: unknown[]) => {
    const conn = connect(key, ...rest);
    const peer = short(key);
    const startedAt = Date.now();
    let err: unknown;
    log("connect.attempt", { peer });
    const onError = (e: unknown) => {
      err = e;
      log("connect.error", { peer, ms: Date.now() - startedAt, err: errText(e) });
    };
    const onClose = () => {
      if (!err) log("connect.close", { peer, ms: Date.now() - startedAt });
    };
    conn.on("error", onError);
    conn.on("close", onClose);
    // Once open the dial is over: a later drop is `conn.close`, not a failed dial.
    conn.once("open", () => {
      log("connect.open", { peer, ms: Date.now() - startedAt });
      conn.off("error", onError);
      conn.off("close", onClose);
    });
    return conn;
  };
  /** `dht.announce` runs `dht.lookup` inside it: that inner call is the announce, not a lookup. */
  let announcing = false;
  const query = (name: "lookup" | "announce") => {
    const original = dht[name].bind(dht);
    dht[name] = (topic: Uint8Array, ...rest: unknown[]) => {
      if (name === "lookup" && announcing) return original(topic, ...rest);
      if (name === "announce") announcing = true;
      let q: any;
      try {
        q = original(topic, ...rest);
      } finally {
        if (name === "announce") announcing = false;
      }
      const hex = Buffer.from(topic).toString("hex");
      const startedAt = Date.now();
      peersSeen.set(hex, 0);
      q.on("error", (e: unknown) =>
        log("lookup.error", { kind: name, topic: short(topic), err: errText(e) }),
      );
      q.on("close", () =>
        log("lookup.done", {
          kind: name,
          topic: short(topic),
          peers: peersSeen.get(hex),
          closest: q.closestNodes?.length,
          ms: Date.now() - startedAt,
        }),
      );
      return q;
    };
  };
  query("lookup");
  query("announce");
  const handlePeer = swarm._handlePeer?.bind(swarm);
  if (handlePeer) {
    swarm._handlePeer = (peer: { publicKey: Uint8Array }, topic: Uint8Array) => {
      const hex = Buffer.from(topic).toString("hex");
      peersSeen.set(hex, (peersSeen.get(hex) ?? 0) + 1);
      log("lookup.peer", { topic: short(topic), peer: short(peer.publicKey) });
      return handlePeer(peer, topic);
    };
  }
  swarm.on("ban", (info: { publicKey: Uint8Array }, e: unknown) =>
    log("connect.ban", { peer: short(info.publicKey), err: errText(e) }),
  );
}

function dhtState(swarm: any) {
  return {
    table: swarm.dht.table?.size,
    firewalled: swarm.dht.firewalled,
    bootstrapped: swarm.dht.bootstrapped,
    conns: swarm.connections.size,
  };
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

export function createHyperPeerNetwork(deps: {
  bootstrap?: string[];
  /** Replicates the drive store over a connection (the store adapter's `replicate`). */
  replicate(conn: unknown): unknown;
  log?: P2pLog;
  /** Dev builds: note every address the peer network uses, shown in `debug().addresses`. */
  recordAddresses?: boolean;
  /** Tests only: replace the per-connection channels. */
  greetPeer?: typeof greetPeer;
  openVersion?: typeof openVersion;
  openAnswers?: typeof openAnswers;
}): PeerNetwork {
  const log = deps.log ?? createP2pLog();
  const swarm: any = new Hyperswarm(deps.bootstrap ? { bootstrap: deps.bootstrap } : undefined);
  const addresses = deps.recordAddresses ? emptyAddressLog() : undefined;
  // Wrapped before dht-rpc's one-tick bind, so its first sockets are noted.
  if (addresses) watchAddresses(swarm.dht.udx, addresses);
  watchSwarm(swarm, log);
  const joins = new Map<string, Handle>();
  const servedTopics = new Set<string>();
  /** Later joins of a topic that upgraded it to serving; left with it. */
  const extraJoins = new Map<string, Handle[]>();
  const rediscoverTimers = new Set<ReturnType<typeof setTimeout>>();
  const peerIdentities = new Set<string>();
  const answersIn = emptyAnswersIn();
  const conns = new Map<
    number,
    {
      noiseKey?: string;
      identityKey?: string;
      openedAt: number;
      initiator?: boolean;
      destroy(): void;
      answers?: { send(answer: ChannelMessage): boolean };
    }
  >();
  let connSeq = 0;
  let ownIdentity = "";
  let ownProtocol = PEER_PROTOCOL;
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
    conns.set(connId, {
      noiseKey,
      openedAt,
      initiator: conn.isInitiator,
      destroy: () => conn.destroy?.(),
    });
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
      (deps.openVersion ?? openVersion)(conn, ownProtocol, (protocol) =>
        emit({ type: "version", conn: connId, protocol }),
      );
    } catch (e: unknown) {
      log("error", { where: "version.open", conn: connId, err: errText(e) });
    }
    try {
      (deps.greetPeer ?? greetPeer)(conn, Buffer.from(ownIdentity, "hex"), (key) => {
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
    try {
      const channel = (deps.openAnswers ?? openAnswers)(conn, (value) => {
        noteAnswerIn(answersIn, { at: Date.now(), conn: connId, value });
        emit({ type: "answer", conn: connId, value });
      });
      const c = conns.get(connId);
      if (c) c.answers = channel;
    } catch (e: unknown) {
      log("error", { where: "answer.open", conn: connId, err: errText(e) });
    }
  }

  type Watch = {
    hasPeer: () => boolean;
    info: { drive: string; peers?: () => number | undefined } | undefined;
    attempt: number;
    /** True while the drive has a peer and the loop only checks that it stays. */
    watching: boolean;
    timer: ReturnType<typeof setTimeout> | undefined;
  };
  /** One lookup loop per topic: repeat calls join it instead of starting another. */
  const watches = new Map<string, Watch>();

  function stopWatch(topic: string) {
    const watch = watches.get(topic);
    if (!watch) return;
    if (watch.timer) {
      clearTimeout(watch.timer);
      rediscoverTimers.delete(watch.timer);
    }
    watches.delete(topic);
  }

  function schedule(topic: string, watch: Watch, ms: number) {
    const timer = setTimeout(() => tick(topic, watch), ms);
    watch.timer = timer;
    rediscoverTimers.add(timer);
  }

  function tick(topic: string, watch: Watch) {
    if (watch.timer) rediscoverTimers.delete(watch.timer);
    if (closed || !joins.has(topic)) {
      watches.delete(topic);
      return;
    }
    if (watch.hasPeer()) {
      watch.watching = true;
      schedule(topic, watch, WATCH_MS);
      return;
    }
    if (watch.watching) {
      watch.watching = false;
      watch.attempt = 0;
    }
    const { info } = watch;
    log("rediscover.attempt", {
      drive: short(info?.drive),
      topic: short(topic),
      n: watch.attempt + 1,
      peers: info?.peers?.(),
    });
    try {
      void Promise.resolve(swarm.status?.(Buffer.from(topic, "hex"))?.refresh()).catch((e) =>
        log("error", { where: "rediscover.refresh", topic: short(topic), err: errText(e) }),
      );
    } catch {
      // discovery gone (topic left meanwhile): expected, quiet
    }
    if (++watch.attempt >= REDISCOVER_MS.length) {
      log("rediscover.giveup", { drive: short(info?.drive), topic: short(topic) });
      watches.delete(topic);
      return;
    }
    schedule(topic, watch, REDISCOVER_MS[watch.attempt]);
  }

  function leave(topic: string) {
    stopWatch(topic);
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
    start(identityKey, onEvent, protocol) {
      ownIdentity = identityKey;
      if (protocol !== undefined) ownProtocol = protocol;
      swarm.on("connection", (conn: any) => onConnection(conn, onEvent));
    },
    sendAnswer(conn, answer) {
      return conns.get(conn)?.answers?.send(answer) ?? false;
    },
    drop(conn) {
      conns.get(conn)?.destroy();
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
      log("topic.join", { topic: short(topic), served: opts.server, ...dhtState(swarm) });
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
    findPeers(topic, hasPeer, info) {
      const running = watches.get(topic);
      if (running) {
        running.hasPeer = hasPeer;
        running.info = info;
        if (!running.watching) running.attempt = 0;
        return;
      }
      const watch: Watch = { hasPeer, info, attempt: 0, watching: false, timer: undefined };
      watches.set(topic, watch);
      schedule(topic, watch, REDISCOVER_MS[0]);
    },
    connectionCount() {
      return swarm.connections.size;
    },
    debug() {
      return {
        ...(addresses ? { addresses } : {}),
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
        answersIn: [...answersIn],
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
