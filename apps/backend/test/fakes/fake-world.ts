/**
 * In-memory p2p world (#200). A hub owns the nodes; each node has its own
 * storage and a `FakeDriveStore` over it. Nodes replicate while both are
 * connected, and keep what they replicated after a disconnect. Drive sharing
 * is per world, so two worlds never see each other's keys.
 *
 * The hub is the place a fake PeerNetwork attaches later: it already knows
 * which nodes are connected.
 */
import type { Drive, DriveEntry, DriveStore, OpenResult } from "../../src/ports/drive-store.ts";
import type { DriveNode, DriveWorld } from "../contracts/drive-store.contract.ts";
import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";

export type FakeWorldOptions = {
  /** Delay before a drive with this key is ready; `Infinity` never resolves. */
  readyDelayMs?: (key: string) => number;
  /** When true, `list` on a drive with this key throws. */
  unreachable?: (key: string) => boolean;
};

type StoredFile = { bytes: Uint8Array; metadata: Record<string, unknown> };

type Replica = {
  key: string;
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
  /** key to the node that writes it. */
  owners: Map<string, FakeNode>;
  handles: Map<Replica, Drive>;
};

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function createFakeHub(options: FakeWorldOptions = {}): FakeHub {
  return { nodes: new Set(), options, owners: new Map(), handles: new Map() };
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

function emptyReplica(key: string): Replica {
  return { key, files: new Map(), length: 0, listeners: new Set() };
}

function copyReplica(options: { from: Replica; to: Replica }): void {
  if (options.to.length === options.from.length) return;
  options.to.files = new Map(options.from.files);
  options.to.length = options.from.length;
  for (const listener of options.to.listeners) listener();
}

/** Copies a drive from its owner to every other connected node that holds it. */
function replicateKey(options: { hub: FakeHub; key: string }): void {
  const { hub, key } = options;
  const owner = hub.owners.get(key);
  const source = owner?.replicas.get(key);
  if (!owner || !owner.connected || !source) return;
  for (const node of connectedNodes(hub)) {
    const target = node.replicas.get(key);
    if (node !== owner && target) copyReplica({ from: source, to: target });
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
  for (const key of hub.owners.keys()) replicateKey({ hub, key });
}

function makeDrive(options: { hub: FakeHub; replica: Replica }): Drive {
  const { hub, replica } = options;
  const key = replica.key;
  function notify() {
    for (const listener of replica.listeners) listener();
  }
  function write(change: () => void) {
    change();
    replica.length++;
    notify();
    replicateKey({ hub, key });
  }
  return {
    key,
    discoveryKey: sha256Hex(`disc:${key}`),
    async readSmall(path, maxBytes) {
      const file = replica.files.get(path);
      if (!file || file.bytes.length > maxBytes) return undefined;
      return Buffer.from(file.bytes).toString("utf8");
    },
    async readBytes(path) {
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
      if (hub.options.unreachable?.(key)) throw new Error("fake drive unreachable");
      const prefix = dir.endsWith("/") ? dir : `${dir}/`;
      for (const [path, file] of replica.files) {
        if (path === dir || !path.startsWith(prefix)) continue;
        const entry: DriveEntry = { path, size: file.bytes.length, metadata: file.metadata };
        yield entry;
      }
    },
    createReadStream(path) {
      return Readable.from([replica.files.get(path)?.bytes ?? new Uint8Array()]);
    },
    onChange(callback) {
      replica.listeners.add(callback);
      return () => {
        replica.listeners.delete(callback);
      };
    },
    stats() {
      const peers = connectedNodes(hub).length - 1;
      return { length: replica.length, peers: Math.max(0, peers) };
    },
  };
}

function handleFor(options: { hub: FakeHub; replica: Replica }): Drive {
  const { hub, replica } = options;
  const existing = hub.handles.get(replica);
  if (existing) return existing;
  const drive = makeDrive({ hub, replica });
  hub.handles.set(replica, drive);
  return drive;
}

async function waitReady(options: { hub: FakeHub; key: string }): Promise<void> {
  const { hub, key } = options;
  const delay = hub.options.readyDelayMs?.(key) ?? 0;
  if (delay === Infinity) return new Promise<void>(() => {});
  if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));
}

export function createFakeDriveStore(options: { hub: FakeHub; node: FakeNode }): DriveStore {
  const { hub, node } = options;
  return {
    async ready() {},
    async openOwn(namespace = "") {
      let key = node.ownKeys.get(namespace);
      if (!key) {
        key = sha256Hex(`key:${node.id}:${namespace}`);
        node.ownKeys.set(namespace, key);
        node.replicas.set(key, emptyReplica(key));
        hub.owners.set(key, node);
      }
      await waitReady({ hub, key });
      const replica = node.replicas.get(key);
      if (!replica) throw new Error("own drive missing");
      return handleFor({ hub, replica });
    },
    async open(key, opts): Promise<OpenResult<Drive>> {
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
        replica = emptyReplica(key);
        node.replicas.set(key, replica);
        replicateKey({ hub, key });
      }
      return [null, handleFor({ hub, replica })];
    },
    async release() {},
    async close() {},
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
