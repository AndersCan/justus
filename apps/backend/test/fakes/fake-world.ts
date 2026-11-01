/**
 * In-memory p2p world (#200). A hub owns the nodes; each node has its own
 * storage and a `FakeDriveStore` over it. Nodes replicate while connected (a
 * longer copy flows from any connected holder, not only the writer) and keep
 * what they replicated after a disconnect. Drive sharing is per world, so two
 * worlds never see each other's keys.
 *
 * The hub is the place a fake PeerNetwork attaches later: it already knows
 * which nodes are connected.
 */
import type { Drive, DriveEntry, DriveStore, OpenResult } from "../../src/ports/drive-store.ts";
import type { DriveNode, DriveWorld } from "../contracts/drive-store.contract.ts";
import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";

export type FakeWorldOptions = {
  /** Delay before a remote drive with this key is ready; `Infinity` never resolves. */
  readyDelayMs?: (key: string) => number;
  /** When true, `list` on a drive with this key throws. */
  unreachable?: (key: string) => boolean;
};

type StoredFile = { bytes: Uint8Array; metadata: Record<string, unknown> };

type Replica = {
  key: string;
  /** True only on the node that created the drive: a replica is read-only, like a remote Hyperdrive. */
  writable: boolean;
  files: Map<string, StoredFile>;
  length: number;
  listeners: Set<() => void>;
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
  options: FakeWorldOptions;
};

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function createFakeHub(options: FakeWorldOptions = {}): FakeHub {
  return { nodes: new Set(), options };
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
  return { ...options, files: new Map(), length: 0, listeners: new Set() };
}

/** Remote changes surface after the writer's call has returned, like a replicated append. */
function notifyLater(replica: Replica): void {
  setImmediate(() => {
    for (const listener of replica.listeners) {
      if (replica.listeners.has(listener)) listener();
    }
  });
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
    if (target.length >= source.length) continue;
    target.files = new Map(source.files);
    target.length = source.length;
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
    for (const listener of replica.listeners) listener();
    replicateKey({ hub, key });
  }

  const drive: Drive = {
    key,
    discoveryKey: sha256Hex(`disc:${key}`),
    async readSmall(path, maxBytes) {
      assertOpen();
      const file = replica.files.get(path);
      if (!file || file.bytes.length > maxBytes) return undefined;
      return Buffer.from(file.bytes).toString("utf8");
    },
    async readBytes(path) {
      assertOpen();
      const file = replica.files.get(path);
      return file ? new Uint8Array(file.bytes) : undefined;
    },
    async put(path, bytes, opts) {
      write(() => {
        replica.files.set(path, { bytes: new Uint8Array(bytes), metadata: opts?.metadata ?? {} });
      });
    },
    async del(path) {
      write(() => {
        replica.files.delete(path);
      });
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
        const listed: DriveEntry = { path, size: file.bytes.length, metadata: file.metadata };
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

export function createFakeDriveStore(options: { hub: FakeHub; node: FakeNode }): DriveStore {
  const { hub, node } = options;
  const entries = new Map<string, Entry>();
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
    async release(drive) {
      const entry = entries.get(drive.key);
      if (!entry || entry.drive !== drive) return;
      entry.refs--;
      if (entry.refs <= 0) closeEntry({ entry, key: drive.key });
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
