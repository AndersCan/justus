/**
 * In-memory p2p world (#200). A hub owns the nodes; each node has its own
 * storage and a `FakeDriveStore` over it. Nodes replicate while connected (a
 * longer copy flows from any connected holder, not only the writer) and keep
 * what they replicated after a disconnect. Drive sharing is per world, so two
 * worlds never see each other's keys.
 *
 * A `FakePeerNetwork` attaches to the same hub: networks that joined one topic,
 * at least one of them serving it, get a connection.
 */
import type {
  Drive,
  DriveEntry,
  DriveStore,
  IdentityProof,
  IdentitySignature,
  OpenResult,
} from "../../src/ports/drive-store.ts";
import type { PeerEvent, PeerNetwork } from "../../src/ports/peer-network.ts";
import type { DriveNode, DriveWorld } from "../contracts/drive-store.contract.ts";
import type { PeerNode, PeerWorld } from "../contracts/peer-network.contract.ts";
import { PEER_PROTOCOL } from "../../src/versions.ts";
import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";

export type FakeWorldOptions = {
  /** Delay before a remote drive with this key is ready; `Infinity` never resolves. */
  readyDelayMs?: (key: string) => number;
  /** When true, `list` on a drive with this key throws. */
  unreachable?: (key: string) => boolean;
};

type StoredFile = {
  bytes: Uint8Array;
  metadata: Record<string, unknown>;
  /** Set when this node dropped the bytes but still knows the entry; the real length. */
  clearedSize?: number;
};

type Replica = {
  key: string;
  /** True only on the node that created the drive: a replica is read-only, like a remote Hyperdrive. */
  writable: boolean;
  files: Map<string, StoredFile>;
  /** The files as they were at each version: `history[v]` is the state at version v. */
  history: Map<string, StoredFile>[];
  length: number;
  listeners: Set<() => void>;
  /** Set by `keepOnly`: the one path whose bytes this replica holds, now and in later versions. */
  keptOnly?: string;
  /** The path the last write put; undefined when the last write was a delete. */
  lastPut?: string;
};

export type FakeNode = {
  id: string;
  connected: boolean;
  /** Survives store restarts. */
  replicas: Map<string, Replica>;
  /** namespace ("" for identity) to key. */
  ownKeys: Map<string, string>;
};

export type FakeHub = {
  nodes: Set<FakeNode>;
  networks: Set<NetworkState>;
  options: FakeWorldOptions;
  /** publicKey to the identity key it signs for and its secret. */
  signers: Map<string, { identityKey: string; secret: string }>;
  /** sealed id to the box key it was sealed for and its message. */
  sealed: Map<string, { pub: string; message: Uint8Array }>;
};

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function fakeSignature(secret: string, message: Uint8Array): string {
  return createHash("sha512")
    .update(`sig:${secret}:${Buffer.from(message).toString("hex")}`)
    .digest("hex");
}

export function createFakeHub(options: FakeWorldOptions = {}): FakeHub {
  return { nodes: new Set(), networks: new Set(), options, signers: new Map(), sealed: new Map() };
}

export function addFakeNode(hub: FakeHub): FakeNode {
  const node: FakeNode = {
    id: randomBytes(8).toString("hex"),
    connected: false,
    replicas: new Map(),
    ownKeys: new Map(),
  };
  hub.nodes.add(node);
  return node;
}

export function connectedNodes(hub: FakeHub): FakeNode[] {
  return [...hub.nodes].filter((node) => node.connected);
}

function emptyReplica(options: { key: string; writable: boolean }): Replica {
  return { ...options, files: new Map(), history: [new Map()], length: 0, listeners: new Set() };
}

/** Remote changes surface after the writer's call has returned, like a replicated append. */
function notifyLater(replica: Replica): void {
  setImmediate(() => {
    for (const listener of replica.listeners) {
      if (replica.listeners.has(listener)) listener();
    }
  });
}

function clearedCopy(file: StoredFile): StoredFile {
  return {
    bytes: new Uint8Array(),
    metadata: file.metadata,
    clearedSize: file.clearedSize ?? file.bytes.length,
  };
}

/** Replaces the replica's maps with new ones that hold only `path`'s bytes; the shared maps are never mutated. */
function clearAllBut(replica: Replica, path: string): void {
  const only = (files: Map<string, StoredFile>) =>
    new Map(
      [...files].map(([p, file]): [string, StoredFile] => [
        p,
        p === path || file.clearedSize !== undefined ? file : clearedCopy(file),
      ]),
    );
  replica.files = only(replica.files);
  replica.history = replica.history.map(only);
}

/**
 * When `path` is the replica's only file and its last write put it, drops every older version
 * (the fake's form of clearing the file index) and returns true; else changes nothing.
 */
function clearOlderVersions(replica: Replica, path: string): boolean {
  const only = [...replica.files.keys()];
  if (only.length !== 1 || only[0] !== path || replica.lastPut !== path) return false;
  replica.history = replica.history.map((files, v) => (v === replica.length ? files : new Map()));
  return true;
}

/** Brings every connected holder of `key` up to the longest copy among them. */
function replicateKey(options: { hub: FakeHub; key: string }): void {
  const holders = connectedNodes(options.hub).flatMap((node) => {
    const replica = node.replicas.get(options.key);
    return replica ? [replica] : [];
  });
  let source: Replica | undefined;
  for (const replica of holders) {
    if (!source || replica.length > source.length) source = replica;
  }
  if (!source) return;
  for (const target of holders) {
    for (const [path, file] of target.files) {
      if (file.clearedSize === undefined || target.keptOnly !== undefined) continue;
      const held = holders
        .map((h) => h.files.get(path))
        .find((f) => f && f.clearedSize === undefined);
      if (!held) continue;
      target.files.set(path, held);
      notifyLater(target);
    }
    if (target.length >= source.length) continue;
    target.files = new Map(source.files);
    target.history = [...source.history];
    target.length = source.length;
    target.lastPut = source.lastPut;
    if (target.keptOnly !== undefined) {
      clearAllBut(target, target.keptOnly);
      clearOlderVersions(target, target.keptOnly);
    }
    notifyLater(target);
  }
}

export function setFakeNodeConnected(options: {
  hub: FakeHub;
  node: FakeNode;
  connected: boolean;
}): void {
  const { hub } = options;
  options.node.connected = options.connected;
  if (!options.connected) return;
  const keys = new Set<string>();
  for (const node of hub.nodes) for (const key of node.replicas.keys()) keys.add(key);
  for (const key of keys) replicateKey({ hub, key });
}

type Entry = {
  drive: Drive;
  refs: number;
  close(): void;
};

function sessionClosed(): Error {
  return new Error("SESSION_CLOSED: drive is closed");
}

function makeEntry(options: { hub: FakeHub; node: FakeNode; replica: Replica }): Entry {
  const { hub, node, replica } = options;
  const key = replica.key;
  const state = { closed: false };
  const unsubscribers = new Set<() => void>();

  function assertOpen(): void {
    if (state.closed) throw sessionClosed();
  }

  function write(change: () => void): void {
    assertOpen();
    if (!replica.writable) throw new Error("Drive is not writable");
    change();
    replica.length++;
    replica.history[replica.length] = new Map(replica.files);
    for (const listener of replica.listeners) listener();
    replicateKey({ hub, key });
  }

  const drive: Drive = {
    key,
    discoveryKey: sha256Hex(`disc:${key}`),
    async readSmall(path, maxBytes) {
      assertOpen();
      const file = replica.files.get(path);
      if (!file || file.clearedSize !== undefined || file.bytes.length > maxBytes) return undefined;
      return Buffer.from(file.bytes).toString("utf8");
    },
    async readBytes(path) {
      assertOpen();
      const file = replica.files.get(path);
      return file && file.clearedSize === undefined ? new Uint8Array(file.bytes) : undefined;
    },
    async put(path, bytes, opts) {
      write(() => {
        replica.files.set(path, { bytes: new Uint8Array(bytes), metadata: opts?.metadata ?? {} });
        replica.lastPut = path;
      });
    },
    async del(path) {
      write(() => {
        replica.files.delete(path);
        replica.lastPut = undefined;
      });
    },
    async clear(path) {
      assertOpen();
      const file = replica.files.get(path);
      if (!file) return;
      replica.files.set(path, {
        bytes: new Uint8Array(),
        metadata: file.metadata,
        clearedSize: file.clearedSize ?? file.bytes.length,
      });
      replicateKey({ hub, key });
    },
    async keepOnly(path): Promise<OpenResult<{ olderVersionsCleared: boolean }>> {
      assertOpen();
      const file = replica.files.get(path);
      if (!file || file.clearedSize !== undefined) {
        return [new Error(`${path} is not on this device`), null];
      }
      replica.keptOnly = path;
      clearAllBut(replica, path);
      return [null, { olderVersionsCleared: clearOlderVersions(replica, path) }];
    },
    async *list(dir) {
      assertOpen();
      if (hub.options.unreachable?.(key)) throw new Error("fake drive unreachable");
      const prefix = dir.endsWith("/") ? dir : `${dir}/`;
      const paths = [...replica.files.keys()].sort((x, y) =>
        Buffer.compare(Buffer.from(x), Buffer.from(y)),
      );
      for (const path of paths) {
        const file = replica.files.get(path);
        if (!file || path === dir || !path.startsWith(prefix)) continue;
        const listed: DriveEntry = {
          path,
          size: file.clearedSize ?? file.bytes.length,
          metadata: file.metadata,
        };
        yield listed;
      }
    },
    createReadStream(path) {
      assertOpen();
      return Readable.from([replica.files.get(path)?.bytes ?? new Uint8Array()]);
    },
    onChange(callback) {
      assertOpen();
      replica.listeners.add(callback);
      function unsubscribe() {
        replica.listeners.delete(callback);
        unsubscribers.delete(unsubscribe);
      }
      unsubscribers.add(unsubscribe);
      return unsubscribe;
    },
    async update() {
      assertOpen();
    },
    version() {
      assertOpen();
      return replica.length;
    },
    stats() {
      assertOpen();
      if (!node.connected) return { length: replica.length, peers: 0 };
      const peers = connectedNodes(hub).filter(
        (other) => other !== node && other.replicas.has(key),
      ).length;
      return { length: replica.length, peers };
    },
  };
  function close(): void {
    state.closed = true;
    for (const unsubscribe of unsubscribers) unsubscribe();
  }

  return { drive, refs: 0, close };
}

async function waitReady(options: { hub: FakeHub; key: string }): Promise<void> {
  const delay = options.hub.options.readyDelayMs?.(options.key) ?? 0;
  if (delay === Infinity) return new Promise<void>(() => {});
  if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));
}

/** A read-only view of a replica's files at a version; reads follow the live drive's closing. */
function makeCopy(options: {
  live: Drive;
  replica: Replica;
  version: number;
  files: Map<string, StoredFile>;
}): Drive {
  const { live, replica, version, files } = options;
  const readOnly = (): never => {
    throw new Error("read-only copy");
  };
  return {
    key: live.key,
    discoveryKey: live.discoveryKey,
    async readSmall(path, maxBytes) {
      const file = files.get(path);
      if (!file || file.clearedSize !== undefined || file.bytes.length > maxBytes) return undefined;
      return Buffer.from(file.bytes).toString("utf8");
    },
    async readBytes(path) {
      const file = files.get(path);
      return file && file.clearedSize === undefined ? new Uint8Array(file.bytes) : undefined;
    },
    put: async () => readOnly(),
    del: async () => readOnly(),
    clear: async () => readOnly(),
    keepOnly: async () => readOnly(),
    async *list(dir) {
      const prefix = dir.endsWith("/") ? dir : `${dir}/`;
      const paths = [...files.keys()].sort((x, y) =>
        Buffer.compare(Buffer.from(x), Buffer.from(y)),
      );
      for (const path of paths) {
        const file = files.get(path);
        if (!file || path === dir || !path.startsWith(prefix)) continue;
        yield { path, size: file.clearedSize ?? file.bytes.length, metadata: file.metadata };
      }
    },
    createReadStream(path) {
      return Readable.from([files.get(path)?.bytes ?? new Uint8Array()]);
    },
    onChange: () => () => {},
    version: () => version,
    stats: () => ({ length: version, peers: live.stats().peers }),
    async update() {},
  };
}

export function createFakeDriveStore(options: { hub: FakeHub; node: FakeNode }): DriveStore {
  const { hub, node } = options;
  const entries = new Map<string, Entry>();
  const copies = new Map<Drive, Drive>();
  let closed = false;

  function assertOpen(): void {
    if (closed) throw new Error("store is closed");
  }

  function acquire(replica: Replica): Drive {
    let entry = entries.get(replica.key);
    if (!entry) {
      entry = makeEntry({ hub, node, replica });
      entries.set(replica.key, entry);
    }
    entry.refs++;
    return entry.drive;
  }

  function closeEntry(options: { entry: Entry; key: string }): void {
    options.entry.close();
    entries.delete(options.key);
  }

  return {
    async ready() {
      assertOpen();
    },
    discoveryKeyOf: (key) => sha256Hex(`disc:${key}`),
    async openOwn(namespace = "") {
      assertOpen();
      let key = node.ownKeys.get(namespace);
      if (!key) {
        key = sha256Hex(`key:${node.id}:${namespace}`);
        node.ownKeys.set(namespace, key);
        node.replicas.set(key, emptyReplica({ key, writable: true }));
      }
      const replica = node.replicas.get(key);
      if (!replica) throw new Error("own drive missing");
      return acquire(replica);
    },
    async signAsIdentity(message): Promise<OpenResult<IdentitySignature>> {
      if (closed) return [new Error("store is closed"), null];
      const own = await this.openOwn("");
      const identityKey = own.key;
      await this.release(own);
      const publicKey = sha256Hex(`pub:${node.id}`);
      let entry = hub.signers.get(publicKey);
      if (!entry) {
        entry = { identityKey, secret: randomBytes(32).toString("hex") };
        hub.signers.set(publicKey, entry);
      }
      return [null, { publicKey, signature: fakeSignature(entry.secret, message) }];
    },
    async boxPublicKey(): Promise<OpenResult<string>> {
      if (closed) return [new Error("store is closed"), null];
      return [null, sha256Hex(`box:${node.id}`)];
    },
    sealFor(boxPublicKey, message): OpenResult<string> {
      if (!/^[0-9a-f]{64}$/i.test(boxPublicKey)) return [new Error("box key is not 64 hex"), null];
      const id = randomBytes(32).toString("hex");
      hub.sealed.set(id, { pub: boxPublicKey.toLowerCase(), message: new Uint8Array(message) });
      return [null, id];
    },
    async openSealed(sealed): Promise<OpenResult<Uint8Array>> {
      if (closed) return [new Error("store is closed"), null];
      const entry = hub.sealed.get(sealed.toLowerCase());
      if (!entry || entry.pub !== sha256Hex(`box:${node.id}`)) {
        return [new Error("not sealed to this phone"), null];
      }
      return [null, new Uint8Array(entry.message)];
    },
    verifyIdentity(proof: IdentityProof): boolean {
      if (!/^[0-9a-f]{64}$/i.test(proof.identityKey)) return false;
      if (!/^[0-9a-f]{64}$/i.test(proof.publicKey)) return false;
      if (!/^[0-9a-f]{128}$/i.test(proof.signature)) return false;
      const entry = hub.signers.get(proof.publicKey.toLowerCase());
      if (!entry || entry.identityKey !== proof.identityKey.toLowerCase()) return false;
      return fakeSignature(entry.secret, proof.message) === proof.signature.toLowerCase();
    },
    async open(key, opts): Promise<OpenResult<Drive>> {
      assertOpen();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<"timeout" | "ready">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), opts.timeoutMs);
      });
      const outcome = await Promise.race([
        waitReady({ hub, key }).then((): "timeout" | "ready" => "ready"),
        timedOut,
      ]);
      clearTimeout(timer);
      if (outcome === "timeout") return [new Error(`drive ${key.slice(0, 8)} not ready`), null];
      let replica = node.replicas.get(key);
      if (!replica) {
        replica = emptyReplica({ key, writable: false });
        node.replicas.set(key, replica);
        replicateKey({ hub, key });
      }
      return [null, acquire(replica)];
    },
    async openAt(key, version, opts): Promise<OpenResult<Drive>> {
      const [err, live] = await this.open(key, opts);
      if (err || !live) return [err ?? new Error("open returned no drive"), null];
      const replica = node.replicas.get(key);
      const deadline = Date.now() + opts.timeoutMs;
      while (!replica || replica.length < version) {
        if (Date.now() >= deadline) {
          await this.release(live);
          return [new Error(`drive ${key.slice(0, 8)} did not reach version ${version}`), null];
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      }
      const copy = makeCopy({
        live,
        replica,
        version,
        files: replica.history[version] ?? new Map(),
      });
      copies.set(copy, live);
      return [null, copy];
    },
    async release(drive) {
      const liveOfCopy = copies.get(drive);
      if (liveOfCopy) {
        copies.delete(drive);
        await this.release(liveOfCopy);
        return;
      }
      const entry = entries.get(drive.key);
      if (!entry || entry.drive !== drive) return;
      entry.refs--;
      if (entry.refs <= 0) closeEntry({ entry, key: drive.key });
    },
    async purge(key) {
      assertOpen();
      const entry = entries.get(key);
      if (entry) closeEntry({ entry, key });
      const replica = node.replicas.get(key);
      if (!replica) return;
      if (replica.writable) {
        replica.files = new Map();
        replica.history = [new Map()];
        replica.length = 0;
      } else {
        node.replicas.delete(key);
      }
    },
    async close() {
      closed = true;
      for (const [key, entry] of entries) closeEntry({ entry, key });
    },
  };
}

/** A fake {@link DriveWorld} per `world()` call, each with its own hub. */
export function fakeDriveWorlds(options: FakeWorldOptions = {}): { world(): DriveWorld } {
  return {
    world() {
      const hub = createFakeHub(options);
      return {
        async node(): Promise<DriveNode> {
          const node = addFakeNode(hub);
          let store = createFakeDriveStore({ hub, node });
          return {
            get store() {
              return store;
            },
            async connect() {
              setFakeNodeConnected({ hub, node, connected: true });
            },
            async disconnect() {
              setFakeNodeConnected({ hub, node, connected: false });
            },
            async restart() {
              node.connected = false;
              await store.close();
              store = createFakeDriveStore({ hub, node });
              return store;
            },
          };
        },
        async close() {},
      };
    },
  };
}

type NetworkState = {
  peerKey: string;
  identityKey: string;
  protocol: number;
  /** A protocol-1 phone: opens no version channel, so no `version` event is emitted. */
  legacy: boolean;
  onEvent: (e: PeerEvent) => void;
  /** topic to whether this network serves it. */
  joins: Map<string, { server: boolean }>;
  /** announced: `connected` was emitted, so `disconnected` may follow. */
  conns: Map<number, { other: NetworkState; otherConn: number; announced: boolean }>;
  closed: boolean;
};

let connSeq = 0;

function linked(a: NetworkState, b: NetworkState): boolean {
  for (const link of a.conns.values()) if (link.other === b) return true;
  return false;
}

function shareServedTopic(a: NetworkState, b: NetworkState): boolean {
  for (const [topic, mine] of a.joins) {
    const theirs = b.joins.get(topic);
    if (theirs && (mine.server || theirs.server)) return true;
  }
  return false;
}

/** Connects every pair that now shares a topic one of them serves. Events arrive after the caller returns, like a socket. */
function matchNetworks(hub: FakeHub): void {
  const all = [...hub.networks].filter((n) => !n.closed);
  for (const [i, a] of all.entries()) {
    for (const b of all.slice(i + 1)) {
      if (linked(a, b) || !shareServedTopic(a, b)) continue;
      const aConn = ++connSeq;
      const bConn = ++connSeq;
      const aLink = { other: b, otherConn: bConn, announced: false };
      const bLink = { other: a, otherConn: aConn, announced: false };
      a.conns.set(aConn, aLink);
      b.conns.set(bConn, bLink);
      setImmediate(() => {
        if (!a.conns.has(aConn) || !b.conns.has(bConn)) return;
        aLink.announced = true;
        bLink.announced = true;
        a.onEvent({ type: "connected", conn: aConn, peerKey: b.peerKey, initiator: true });
        b.onEvent({ type: "connected", conn: bConn, peerKey: a.peerKey, initiator: false });
        if (!a.legacy && !b.legacy) {
          a.onEvent({ type: "version", conn: aConn, protocol: b.protocol });
          b.onEvent({ type: "version", conn: bConn, protocol: a.protocol });
        }
        a.onEvent({ type: "identified", conn: aConn, identityKey: b.identityKey });
        b.onEvent({ type: "identified", conn: bConn, identityKey: a.identityKey });
      });
    }
  }
}

function dropConn(options: { state: NetworkState; conn: number }): void {
  const link = options.state.conns.get(options.conn);
  if (!link) return;
  options.state.conns.delete(options.conn);
  link.other.conns.delete(link.otherConn);
  if (!link.announced) return;
  options.state.onEvent({ type: "disconnected", conn: options.conn, peerKey: link.other.peerKey });
  link.other.onEvent({
    type: "disconnected",
    conn: link.otherConn,
    peerKey: options.state.peerKey,
  });
}

/** Each call is a new network with a fresh random peer key, unrelated to any identity key. */
export function createFakePeerNetwork(options: { hub: FakeHub; legacy?: boolean }): PeerNetwork {
  const { hub } = options;
  const state: NetworkState = {
    peerKey: randomBytes(32).toString("hex"),
    identityKey: "",
    protocol: PEER_PROTOCOL,
    legacy: options.legacy ?? false,
    onEvent: () => {},
    joins: new Map(),
    conns: new Map(),
    closed: false,
  };
  hub.networks.add(state);

  return {
    peerKey() {
      return state.peerKey;
    },
    start(identityKey, onEvent, protocol) {
      state.identityKey = identityKey;
      state.onEvent = onEvent;
      if (protocol !== undefined) state.protocol = protocol;
    },
    sendAnswer(conn, answer) {
      if (state.closed) return false;
      const link = state.conns.get(conn);
      if (!link || !link.announced) return false;
      // The wire is JSON: the receiver gets a copy, never the sender's object.
      const value: unknown = JSON.parse(JSON.stringify(answer));
      const { other, otherConn } = link;
      setImmediate(() => {
        if (!other.conns.has(otherConn)) return;
        other.onEvent({ type: "answer", conn: otherConn, value });
      });
      return true;
    },
    drop(conn) {
      dropConn({ state, conn });
    },
    join(topic, opts) {
      if (state.closed) return;
      const existing = state.joins.get(topic);
      if (existing && (existing.server || !opts.server)) return;
      state.joins.set(topic, { server: opts.server });
      matchNetworks(hub);
    },
    leave(topic) {
      state.joins.delete(topic);
    },
    findPeers() {
      // Joining already connects everything reachable; there is no lookup to repeat.
    },
    connectionCount() {
      return state.conns.size;
    },
    debug() {
      return {
        swarmKey: state.peerKey,
        swarmConnections: state.conns.size,
        joins: [...state.joins].map(([topic, join]) => ({ topic, served: join.server })),
      };
    },
    async close() {
      if (state.closed) return;
      for (const conn of state.conns.keys()) dropConn({ state, conn });
      state.closed = true;
      state.joins.clear();
      hub.networks.delete(state);
    },
  };
}

/** A fake {@link PeerWorld} per `world()` call, each with its own hub. */
export function fakePeerWorlds(): { world(): PeerWorld } {
  return {
    world() {
      const hub = createFakeHub();
      const nodes: PeerNode[] = [];
      return {
        async node(opts?: { legacy?: boolean }) {
          const identityKey = randomBytes(32).toString("hex");
          const events: PeerEvent[] = [];
          function build(): PeerNetwork {
            const network = createFakePeerNetwork({ hub, legacy: opts?.legacy });
            network.start(identityKey, (e) => events.push(e));
            return network;
          }
          let network = build();
          const node: PeerNode = {
            get network() {
              return network;
            },
            identityKey,
            events,
            async restart() {
              await network.close();
              network = build();
              return network;
            },
          };
          nodes.push(node);
          return node;
        },
        topic: () => randomBytes(32).toString("hex"),
        async close() {
          for (const node of nodes) await node.network.close();
        },
      };
    },
  };
}
