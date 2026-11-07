/**
 * Temporary (#200 T9): a `DriveStore` over the old `makeCorestore`/`makeDrive`
 * hooks, so the test files that still override `makeDrive` keep working while
 * `photo-store` talks to the port. T11 moves those tests onto `fake-world.ts`
 * and deletes this file.
 */
import { toDriveEntry } from "../../src/adapters/hyper-drive-store.ts";
import type { Drive, DriveStore, OpenResult } from "../../src/ports/drive-store.ts";
import { join } from "node:path";

export type LegacyHooks = {
  storageDir: string;
  makeCorestore: (dir: string) => any;
  makeDrive: (corestore: any, key?: Buffer) => any;
};

type Held = { raw: any; drive: Drive; refs: number };

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function wrap(raw: any): Drive {
  return {
    key: toHex(raw.key),
    discoveryKey: toHex(raw.discoveryKey),
    async readSmall(path, maxBytes, opts) {
      const readOpts = opts ? { timeout: opts.timeoutMs } : undefined;
      if (typeof raw.entry === "function") {
        const size = (await raw.entry(path, readOpts))?.value?.blob?.byteLength;
        if (typeof size === "number" && size > maxBytes) return undefined;
      }
      const bytes = await raw.get(path, readOpts);
      if (bytes === null || bytes === undefined || bytes.byteLength > maxBytes) return undefined;
      return Buffer.from(bytes).toString("utf8");
    },
    async readBytes(path) {
      return (await raw.get(path)) ?? undefined;
    },
    async put(path, bytes, opts) {
      await raw.put(path, Buffer.from(bytes), opts?.metadata ? { metadata: opts.metadata } : {});
    },
    async del(path) {
      await raw.del(path);
    },
    async clear(path) {
      await raw.clear(path);
    },
    async *list(dir) {
      for await (const entry of raw.list(dir)) yield toDriveEntry(entry);
    },
    createReadStream: (path) => raw.createReadStream(path),
    onChange(cb) {
      raw.core.on("append", cb);
      raw.core.on("truncate", cb);
      return () => {
        raw.core.removeListener("append", cb);
        raw.core.removeListener("truncate", cb);
      };
    },
    stats() {
      const peers = raw.core?.peers;
      // A drive that does not track peers counts as served, so nothing re-runs its lookup.
      return { length: raw.core?.length ?? 0, peers: Array.isArray(peers) ? peers.length : 1 };
    },
    version() {
      return raw.version ?? raw.core?.length ?? 0;
    },
    async update() {
      await raw.update?.();
    },
  };
}

/** Hooks are read on every call, so a test may replace them after the store is built. */
export function createLegacyDriveStore(hooks: () => LegacyHooks): DriveStore & {
  replicate(conn: unknown): void;
} {
  const held = new Map<string, Held>();
  let corestore: any;

  function store(): any {
    corestore ??= hooks().makeCorestore(join(hooks().storageDir, "corestore"));
    return corestore;
  }

  function hold(raw: any): Drive {
    const key = toHex(raw.key);
    let entry = held.get(key);
    if (!entry) {
      entry = { raw, drive: wrap(raw), refs: 0 };
      held.set(key, entry);
    }
    entry.refs++;
    return entry.drive;
  }

  return {
    replicate: (conn) => store().replicate(conn),
    ready: () => store().ready(),
    /** The fakes cache a drive by key, so a key already made has the topic it was made with. Fakes only: a real Hyperdrive built here would hold its core. */
    discoveryKeyOf: (key) =>
      toHex(hooks().makeDrive(store(), Buffer.from(key, "hex")).discoveryKey),
    async openOwn(namespace) {
      const cs = store();
      await cs.ready();
      const raw = hooks().makeDrive(namespace ? cs.namespace(namespace) : cs);
      await raw.ready();
      return hold(raw);
    },
    async open(key, { timeoutMs }): Promise<OpenResult<Drive>> {
      const known = held.get(key);
      if (known) {
        known.refs++;
        return [null, known.drive];
      }
      const raw = hooks().makeDrive(store(), Buffer.from(key, "hex"));
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          raw.ready(),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("timeout opening remote drive")), timeoutMs);
          }),
        ]);
      } catch (e: unknown) {
        void Promise.resolve(raw.close?.()).catch(() => {});
        return [e instanceof Error ? e : new Error(String(e)), null];
      } finally {
        clearTimeout(timer);
      }
      return [null, hold(raw)];
    },
    async openAt(): Promise<OpenResult<Drive>> {
      return [new Error("openAt is not supported by the legacy drive store"), null];
    },
    async release(drive) {
      const entry = held.get(drive.key);
      if (!entry || entry.drive !== drive) return;
      entry.refs--;
      if (entry.refs > 0) return;
      held.delete(drive.key);
      await Promise.resolve(entry.raw.close?.()).catch(() => {});
    },
    async purge(key) {
      const entry = held.get(key);
      if (entry) {
        held.delete(key);
        await entry.raw.purge?.();
        return;
      }
      const raw = hooks().makeDrive(store(), Buffer.from(key, "hex"));
      try {
        await raw.ready();
        await raw.purge?.();
      } finally {
        await Promise.resolve(raw.close?.()).catch(() => {});
      }
    },
    async close() {
      for (const entry of held.values()) await Promise.resolve(entry.raw.close?.()).catch(() => {});
      held.clear();
      await corestore?.close?.();
    },
  };
}
