/**
 * In-memory substitutes for the p2p constructs `createPhotoStore` builds at
 * runtime, plus the dependency-injection helper that wires them in. They
 * implement exactly the `Drive` / `Corestore` / `Hyperswarm` / `LoopbackServer`
 * surface `photo-store.ts` uses (see docs/design/fake-drive-test-harness-spec.md),
 * so the six drive-dependent bugs (#42/#43/#46/#47/#49/#52) become deterministic,
 * fast unit tests with no Bare runtime.
 *
 * Only the functions actually called by the store are implemented; everything
 * else is a no-op. Stream fidelity is intentionally deferred (those bugs need
 * no real bytes).
 */
import { makeTmpDir } from "./tmp-dirs.ts";
import { createHash } from "node:crypto";
import * as nodeCrypto from "node:crypto";
import * as nodeFs from "node:fs";
import * as nodePath from "node:path";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import type { PhotoStore, PhotoStoreDeps } from "../src/photo-store.ts";
import { createHyperPeerNetwork } from "../src/adapters/hyper-peer-network.ts";
import { createP2pLog } from "../src/p2p-log.ts";
import type { PeerNetwork } from "../src/ports/peer-network.ts";
import { createLegacyDriveStore, type LegacyHooks } from "./fakes/legacy-drive-store.ts";

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** A 64-char hex string is treated as a literal drive key (see FakeDrive). */
const HEX64 = /^[0-9a-f]{64}$/;

/** Minimal EventEmitter used by the fake p2p handles. */
class Emitter {
  private handlers = new Set<(...args: any[]) => void>();
  on(_event: string, handler: (...args: any[]) => void): void {
    this.handlers.add(handler);
  }
  removeListener(_event: string, handler: (...args: any[]) => void): void {
    this.handlers.delete(handler);
  }
  emit(_name: string, ...args: any[]): void {
    for (const h of this.handlers) h(...args);
  }
}

/** In-memory Hyperdrive. Data lives in a `Map`; `.key`/`.discoveryKey` are
 * derived deterministically from the constructor seed so that two fakes with
 * the same seed share an identity (required for #42/#43/#47). */
export class FakeDrive extends Emitter {
  readonly key: Buffer;
  readonly discoveryKey: Buffer;
  /** The index core. Like real Hyperdrive, changes surface only here, as
   * `"append"`: the drive itself emits no `"update"` event. */
  readonly core = new Emitter();
  private files = new Map<string, Buffer>();
  /** Mirrors the real hyperdrive `put(path, data, { metadata })` contract:
   * custom metadata travels alongside the bytes and is surfaced by `list()`
   * as `entry.value.metadata` (consumed by `deriveGallery`). */
  private metadata = new Map<string, Record<string, unknown>>();
  /** Test hook: when true, `list()` throws (models an unreachable / not-yet-
   * downloaded peer drive). Lets a scenario assert that dedupe and gallery
   * derivation no longer depend on the drive being reachable at call time
   * (issue #43). */
  unreachable = false;

  /** Test hook: when > 0, `ready()` resolves only after this many ms; when
   * `Infinity`, `ready()` never resolves (models a drive that is announced but
   * whose blocks never arrive — an unreachable peer). Lets a scenario assert
   * that `requests()` no longer multiplies per-peer open latency across
   * unreachable peers (issue #88). */
  private readyDelayMs: number;

  constructor(seed: string, opts: { readyDelayMs?: number } = {}) {
    super();
    // A 64-char hex seed is treated as the literal drive key. This lets a drive
    // opened *by key* resolve to the same identity as one created *without* a key
    // (whose `.key` is derived from its seed) — required so several stores that
    // share a drive registry agree on a drive's identity for the multi-device
    // scenarios (#43/#49/#52).
    this.key = HEX64.test(seed)
      ? Buffer.from(seed, "hex")
      : Buffer.from(sha256Hex(`key:${seed}`), "hex");
    this.discoveryKey = Buffer.from(sha256Hex(`disc:${seed}`), "hex");
    this.readyDelayMs = opts.readyDelayMs ?? 0;
  }

  async ready(): Promise<void> {
    if (this.readyDelayMs === Infinity) {
      // Never resolves — models an unreachable peer drive.
      return new Promise<void>(() => {});
    }
    if (this.readyDelayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, this.readyDelayMs));
    }
  }
  async close(): Promise<void> {}

  async get(path: string): Promise<Buffer | null> {
    return this.files.get(path) ?? null;
  }

  async put(
    path: string,
    data: Buffer,
    opts?: { metadata?: Record<string, unknown> },
  ): Promise<void> {
    this.files.set(path, Buffer.from(data));
    this.metadata.set(path, opts?.metadata ?? {});
    this.core.emit("append");
  }

  /** Mirrors Hyperdrive `clear`: the bytes go, the entry stays. */
  async clear(path: string): Promise<void> {
    if (this.files.has(path)) this.files.set(path, Buffer.alloc(0));
    this.cleared.add(path);
  }

  /** Mirrors Hyperdrive `purge`: the whole drive is gone from this phone. */
  async purge(): Promise<void> {
    this.files.clear();
    this.metadata.clear();
    this.purged = true;
  }

  /** Test hook: paths whose bytes were cleared. */
  readonly cleared = new Set<string>();
  /** Test hook: true once `purge()` ran. */
  purged = false;

  async del(path: string): Promise<void> {
    this.files.delete(path);
    this.metadata.delete(path);
    this.core.emit("append");
  }

  // The real p2p `Drive.list` returns an *async iterable* (consumed with
  // `for await`), not a Promise — model that faithfully so `listPhotosIn` and
  // `drivePhotoKeys` iterate entries instead of silently yielding nothing.
  // Each entry carries `value.metadata` (custom metadata set via `put(path,
  // data, { metadata })`); `deriveGallery` reads it to surface the readable
  // filename the add path threaded through (v2 seam parity, issue #19).
  async *list(path: string): AsyncIterable<{
    key: string;
    value: { blob: { byteLength: number }; metadata: Record<string, unknown> };
  }> {
    if (this.unreachable) throw new Error("fake drive unreachable");
    const prefix = path.endsWith("/") ? path : `${path}/`;
    for (const key of this.files.keys()) {
      if (key === path) continue;
      if (key.startsWith(prefix)) {
        // Same shape as Hyperdrive: the length lives on the blob pointer.
        const byteLength = this.files.get(key)?.length ?? 0;
        yield { key, value: { blob: { byteLength }, metadata: this.metadata.get(key) ?? {} } };
      }
    }
  }

  createReadStream(path: string): Readable {
    return Readable.from(this.files.get(path) ?? Buffer.alloc(0));
  }

  /** Test helper — fire the index core's `append` handlers (simulates replication). */
  emitUpdate(): void {
    this.core.emit("append");
  }

  /** Test helper — inspect the in-memory contents. */
  readFile(path: string): Buffer | null {
    return this.files.get(path) ?? null;
  }

  /** Test helper — count photos stored under `/photos` (independent of the
   * `list()` reachability flag) so a scenario can assert no duplicate was
   * written (issue #43). */
  countPhotos(): number {
    let n = 0;
    for (const key of this.files.keys()) if (key.startsWith("/photos/")) n++;
    return n;
  }
}

let corestoreCounter = 0;

/** In-memory Corestore. The same instance is reused across `makeDrive` calls
 * so drive identity is stable for the lifetime of one store. Like the real
 * one, a keyless drive is the store's (or namespace's) default core: two
 * keyless drives on the same namespace are the same drive. */
export class FakeCorestore {
  constructor(readonly path = `corestore-${corestoreCounter++}`) {}
  namespace(name: string): FakeCorestore {
    return new FakeCorestore(`${this.path}/${name}`);
  }
  async ready(): Promise<void> {}
  replicate(_conn: unknown): void {}
  async close(): Promise<void> {}
}

/** In-memory Hyperswarm. No peers by default; `connections` is an empty set. */
export class FakeSwarm extends Emitter {
  readonly connections = new Set<unknown>();
  keyPair: { publicKey: Buffer } = { publicKey: nodeCrypto.randomBytes(32) };
  join(
    _topic: Buffer,
    _opts?: { server?: boolean },
  ): {
    flushed?: () => Promise<void>;
    destroy(): void | Promise<void>;
  } {
    return { flushed: () => Promise.resolve(), destroy: () => {} };
  }
  destroy(): void {}
}

/** In-memory LoopbackServer. Routes are recorded so tests can assert mounts. */
export class FakeLoopbackServer {
  private routes = new Map<string, string>();
  async mount(route: string, target: string): Promise<void> {
    this.routes.set(route, target);
  }
  async unmount(route: string): Promise<void> {
    this.routes.delete(route);
  }
  async origin(): Promise<string> {
    return "http://localhost:0";
  }
  async url(path: string): Promise<string> {
    return `http://localhost:0${path}`;
  }
  token(): string {
    return "";
  }
  async credentials(): Promise<{
    origin: string;
    port: number;
    token: string;
    bootstrap: string;
  }> {
    return { origin: "http://localhost:0", port: 0, token: "", bootstrap: "" };
  }
  mountDir(_prefix: string, _dirPath: string, _opts?: { public?: boolean }): void {}
  onConnection(_handler: unknown): void {}
  private handlers = new Map<string, (req: unknown, res: unknown) => void>();
  registerRoute(method: string, path: string, handler: unknown): void {
    this.handlers.set(`${method} ${path}`, handler as (req: unknown, res: unknown) => void);
    this.routes.set(path, `${method} route`);
  }
  /** Load a registered GET route the way the WebView would. */
  async getForTest(
    path: string,
  ): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
    const handler = this.handlers.get(`GET ${path}`);
    if (!handler) return { status: 404, headers: {}, body: Buffer.alloc(0) };
    const chunks: Buffer[] = [];
    let status = 0;
    let headers: Record<string, string> = {};
    const res = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(Buffer.from(chunk));
        cb();
      },
    }) as Writable & { writeHead(s: number, h: Record<string, string>): void };
    res.writeHead = (s, h) => {
      status = s;
      headers = h;
    };
    const done = new Promise<void>((resolve) => res.on("finish", () => resolve()));
    handler({ method: "GET", url: path, headers: {} }, res);
    await done;
    return { status, headers, body: Buffer.concat(chunks) };
  }
  push(_frame: Uint8Array): boolean {
    return false;
  }
  close(_cb?: (err?: Error | null) => void): void {}
  routesForTest(): Map<string, string> {
    return this.routes;
  }
}

/** Drives are cached by their canonical key so re-opening a drive (by key, or
 * as a device's own drive) returns the SAME instance — its contents then
 * persist across the open/reopen cycle (modelling p2p replication). This is
 * also what lets multiple stores share one drive registry for #43/#49/#52. */
const driveCache = new Map<string, FakeDrive>();

/** Temporary (T11 removes it): the old drive hooks, which `drives` is built from. */
export type LegacyDriveHooks = Pick<LegacyHooks, "makeCorestore" | "makeDrive">;

/** Temporary (T11 removes it): the old swarm and channel hooks, which `network` is built from. */
export type LegacyNetworkHooks = {
  replicate?: (conn: any) => void;
  makeSwarm?: () => unknown;
  greetPeer?: (conn: unknown, own: Uint8Array, onIdentity: (key: Uint8Array) => void) => void;
  openVersion?: (conn: unknown, own: number, onVersion: (remote: number) => void) => void;
  openAnswers?: any;
};

export type FakeDeps = PhotoStoreDeps & LegacyDriveHooks & LegacyNetworkHooks;

/** A PeerNetwork over the old hooks, built on first use so a test may replace them first. */
function createLegacyNetwork(deps: () => FakeDeps): PeerNetwork {
  let inner: PeerNetwork | undefined;
  function net(): PeerNetwork {
    if (inner) return inner;
    const created = createHyperPeerNetwork({
      swarm: deps().makeSwarm?.(),
      replicate: (conn) => {
        const d = deps();
        if (d.replicate) d.replicate(conn);
        else (d.drives as { replicate?(conn: unknown): void }).replicate?.(conn);
      },
      greetPeer: deps().greetPeer,
      openVersion: deps().openVersion,
      openAnswers: deps().openAnswers,
      log: createP2pLog(deps().log),
    });
    inner = created;
    return created;
  }
  return {
    peerKey: () => net().peerKey(),
    start: (identityKey, onEvent, protocol) => net().start(identityKey, onEvent, protocol),
    sendAnswer: (conn, answer) => net().sendAnswer(conn, answer),
    drop: (conn) => net().drop(conn),
    join: (topic, opts) => net().join(topic, opts),
    leave: (topic) => net().leave(topic),
    findPeers: (topic, hasPeer, info) => net().findPeers(topic, hasPeer, info),
    connectionCount: () => net().connectionCount(),
    debug: () => net().debug(),
    close: () => (inner ? inner.close() : Promise.resolve()),
  };
}

/** Rebuilds `deps.drives` and `deps.network` from the hooks in `deps`, after a test replaced a hook or `log` on a copy. */
export function withDriveHooks(deps: FakeDeps, hooks: Partial<LegacyDriveHooks>): FakeDeps {
  const next = { ...deps, ...hooks } as FakeDeps;
  const drives = createLegacyDriveStore(() => next);
  next.drives = drives;
  next.network = createLegacyNetwork(() => next);
  return next;
}

/** Builds a `PhotoStoreDeps` that runs entirely in memory via the fake
 * constructs above. Pass it straight to `createPhotoStore`. A test may still
 * override `makeCorestore` / `makeDrive`; `drives` is then built from them. */
export function makeFakeDeps(
  overrides: Partial<PhotoStoreDeps> & Partial<LegacyDriveHooks> & LegacyNetworkHooks = {},
): FakeDeps {
  const dir = makeTmpDir("justus-fake-");
  const corestore = new FakeCorestore();
  const deps = {
    storageDir: dir,
    cacheDir: join(dir, "cache"),
    server: new FakeLoopbackServer(),
    deviceName: "Tester",
    onChanged: () => {},
    seedOnEmpty: false,
    // Node's fs/path/crypto are runtime-compatible with the bare-*` shapes the
    // seam expects (writeFileSync/rmSync, join, randomBytes/createHash) and let
    // the store run under Node/vitest without the Bare runtime.
    fs: nodeFs as unknown as typeof import("bare-fs"),
    path: nodePath as unknown as typeof import("bare-path"),
    crypto: nodeCrypto as unknown as typeof import("bare-crypto"),
    makeCorestore: () => corestore,
    makeSwarm: () => new FakeSwarm(),
    // Real devices send their identity drive key over a protomux channel; a
    // fake connection carries it as `identityKey` (see `fakeConnection`).
    greetPeer: (conn: unknown, _own: Uint8Array, onIdentity: (key: Uint8Array) => void) => {
      const id = (conn as { identityKey?: Buffer }).identityKey;
      if (id) onIdentity(id);
    },
    // Fake connections carry no protomux muxer: the remote reports our own protocol.
    openVersion: (_conn: unknown, own: number, onVersion: (remote: number) => void) =>
      onVersion(own),
    // Fake connections carry no protomux muxer, so there is no answer channel.
    openAnswers: () => ({ send: () => false }),
    makeDrive: (cs: unknown, key?: Buffer) => {
      const seed = key ? key.toString("hex") : `${(cs as FakeCorestore).path}/db`;
      const drive = new FakeDrive(seed);
      const id = drive.key.toString("hex");
      const cached = driveCache.get(id);
      if (cached) return cached;
      driveCache.set(id, drive);
      return drive;
    },
    ...overrides,
  } as FakeDeps;
  if (!overrides.network) deps.network = createLegacyNetwork(() => deps);
  if (overrides.drives) return deps;
  return withDriveHooks(deps, {});
}

/** Makes `joiner` a Member of the Admin's album the way the app does: the
 * joiner asks with its drive for that album (a pending reader), the Admin
 * approves that key, and joining again picks up the approval. Returns the
 * joiner's member key (its drive key in that album). */
export async function joinAsMember(
  admin: PhotoStore,
  folderId: string,
  joiner: PhotoStore,
  shareKey: string,
): Promise<string> {
  const asked = await joiner.join(shareKey);
  if (asked[0]) throw asked[0];
  const pending = (await joiner.folders()).folders.find((f) => f.shareKey === shareKey)!;
  const approved = await admin.respond(folderId, pending.driveKey, true);
  if (approved[0]) throw approved[0];
  const joined = await joiner.join(shareKey);
  if (joined[0]) throw joined[0];
  return pending.driveKey;
}

/** A fake swarm connection from the device whose identity drive is
 * `identityKey`. Like a real one, its `remotePublicKey` is a separate per-boot
 * noise key, never a drive key. */
export function fakeConnection(identityKey: Buffer) {
  return {
    remotePublicKey: nodeCrypto.randomBytes(32),
    identityKey,
    on: () => {},
  };
}
