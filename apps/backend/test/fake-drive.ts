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
import { createHash } from "node:crypto";
import * as nodeCrypto from "node:crypto";
import * as nodeFs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { PhotoStoreDeps } from "../src/photo-store.ts";

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
  emit(...args: any[]): void {
    for (const h of this.handlers) h(...args);
  }
}

/** In-memory Hyperdrive. Data lives in a `Map`; `.key`/`.discoveryKey` are
 * derived deterministically from the constructor seed so that two fakes with
 * the same seed share an identity (required for #42/#43/#47). */
export class FakeDrive extends Emitter {
  readonly key: Buffer;
  readonly discoveryKey: Buffer;
  private files = new Map<string, Buffer>();
  /** Test hook: when true, `list()` throws (models an unreachable / not-yet-
   * downloaded peer drive). Lets a scenario assert that dedupe and gallery
   * derivation no longer depend on the drive being reachable at call time
   * (issue #43). */
  unreachable = false;

  constructor(seed: string) {
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
  }

  async ready(): Promise<void> {}
  async close(): Promise<void> {}

  async get(path: string): Promise<Buffer | null> {
    return this.files.get(path) ?? null;
  }

  async put(path: string, data: Buffer): Promise<void> {
    this.files.set(path, Buffer.from(data));
    this.emit("update");
  }

  async del(path: string): Promise<void> {
    this.files.delete(path);
    this.emit("update");
  }

  // The real p2p `Drive.list` returns an *async iterable* (consumed with
  // `for await`), not a Promise — model that faithfully so `listPhotosIn` and
  // `drivePhotoKeys` iterate entries instead of silently yielding nothing.
  async *list(path: string): AsyncIterable<{ key: string; name: string }> {
    if (this.unreachable) throw new Error("fake drive unreachable");
    const prefix = path.endsWith("/") ? path : `${path}/`;
    for (const key of this.files.keys()) {
      if (key === path) continue;
      if (key.startsWith(prefix)) yield { key, name: key.slice(prefix.length) };
    }
  }

  createReadStream(_path: string): Readable {
    return Readable.from(Buffer.alloc(0));
  }

  /** Test helper — fire the drive's `update` handlers (simulates replication). */
  emitUpdate(): void {
    this.emit("update");
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

/** In-memory Corestore. The same instance is reused across `makeDrive` calls
 * so drive identity is stable for the lifetime of one store. */
export class FakeCorestore {
  async ready(): Promise<void> {}
  replicate(_conn: unknown): void {}
  async close(): Promise<void> {}
}

/** In-memory Hyperswarm. No peers by default; `connections` is an empty set. */
export class FakeSwarm extends Emitter {
  readonly connections = new Set<unknown>();
  join(_topic: Buffer, _opts?: { server?: boolean }): { flushed?: () => Promise<void> } {
    return { flushed: () => Promise.resolve() };
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
  async credentials(): Promise<{ origin: string; port: number; token: string }> {
    return { origin: "http://localhost:0", port: 0, token: "" };
  }
  mountDir(_prefix: string, _dirPath: string): void {}
  onConnection(_handler: unknown): void {}
  registerRoute(_method: string, _path: string, _handler: unknown): void {}
  push(_frame: Uint8Array): boolean {
    return false;
  }
  close(_cb?: (err?: Error | null) => void): void {}
  routesForTest(): Map<string, string> {
    return this.routes;
  }
}

let seedCounter = 0;

/** Drives are cached by their canonical key so re-opening a drive (by key, or
 * as a device's own drive) returns the SAME instance — its contents then
 * persist across the open/reopen cycle (modelling p2p replication). This is
 * also what lets multiple stores share one drive registry for #43/#49/#52. */
const driveCache = new Map<string, FakeDrive>();

/** Builds a `PhotoStoreDeps` that runs entirely in memory via the fake
 * constructs above. Pass it straight to `createPhotoStore`. */
export function makeFakeDeps(overrides: Partial<PhotoStoreDeps> = {}): PhotoStoreDeps {
  const dir = mkdtempSync(join(tmpdir(), "justus-fake-"));
  const corestore = new FakeCorestore();
  return {
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
    makeDrive: (_cs: unknown, key?: Buffer) => {
      const seed = key ? key.toString("hex") : `seed-${seedCounter++}`;
      const drive = new FakeDrive(seed);
      const id = drive.key.toString("hex");
      const cached = driveCache.get(id);
      if (cached) return cached;
      driveCache.set(id, drive);
      return drive;
    },
    ...overrides,
  } as PhotoStoreDeps;
}
