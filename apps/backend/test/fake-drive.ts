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
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { PhotoStoreDeps } from "../src/photo-store";

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

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
    for (const h of [...this.handlers]) h(...args);
  }
}

/** In-memory Hyperdrive. Data lives in a `Map`; `.key`/`.discoveryKey` are
 * derived deterministically from the constructor seed so that two fakes with
 * the same seed share an identity (required for #42/#43/#47). */
export class FakeDrive extends Emitter {
  readonly key: Buffer;
  readonly discoveryKey: Buffer;
  private files = new Map<string, Buffer>();

  constructor(seed: string) {
    super();
    this.key = Buffer.from(sha256Hex(`key:${seed}`), "hex");
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

  async list(path: string): Promise<Array<{ name: string }>> {
    const prefix = path.endsWith("/") ? path : `${path}/`;
    const out: Array<{ name: string }> = [];
    for (const key of this.files.keys()) {
      if (key === path) continue;
      if (key.startsWith(prefix)) out.push({ name: key.slice(prefix.length) });
    }
    return out;
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
  routesForTest(): Map<string, string> {
    return this.routes;
  }
}

let seedCounter = 0;

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
    makeCorestore: () => corestore,
    makeSwarm: () => new FakeSwarm(),
    makeDrive: (_cs: unknown, key?: Buffer) =>
      new FakeDrive(key ? key.toString("hex") : `seed-${seedCounter++}`),
    ...overrides,
  } as PhotoStoreDeps;
}
