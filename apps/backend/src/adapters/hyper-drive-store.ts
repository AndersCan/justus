import { short, type P2pLog } from "../p2p-log";
import type { Drive, DriveEntry, DriveStore } from "../ports/drive-store";
import Corestore from "corestore";
import Hyperdrive from "hyperdrive";

type Entry = { raw: any; drive: Drive; refs: number };

export type HyperDriveStore = DriveStore & {
  /** Replicates every core over a connection. Not on the port: only the composition root hands it to the network. */
  replicate(conn: unknown): unknown;
};

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

/** Maps a raw Hyperdrive list entry to the port's `DriveEntry`. */
export function toDriveEntry(e: any): DriveEntry {
  return {
    path: e.key,
    size: e.value?.blob?.byteLength ?? 0,
    metadata: e.value?.metadata ?? {},
  };
}

function wrap(raw: any): Drive {
  return {
    key: toHex(raw.key),
    discoveryKey: toHex(raw.discoveryKey),
    async readSmall(path, maxBytes) {
      const node = await raw.entry(path);
      const size = node?.value?.blob?.byteLength;
      if (typeof size === "number" && size > maxBytes) return undefined;
      const bytes = await raw.get(path);
      if (bytes === null || bytes === undefined || bytes.byteLength > maxBytes) return undefined;
      // Not TextDecoder: Bare has no global one (#201).
      return Buffer.from(bytes).toString("utf8");
    },
    async readBytes(path) {
      const bytes = await raw.get(path);
      return bytes ?? undefined;
    },
    async put(path, bytes, opts) {
      await raw.put(path, Buffer.from(bytes), opts?.metadata ? { metadata: opts.metadata } : {});
    },
    async del(path) {
      await raw.del(path);
    },
    async *list(dir): AsyncGenerator<DriveEntry> {
      for await (const e of raw.list(dir)) {
        yield toDriveEntry(e);
      }
    },
    createReadStream(path) {
      return raw.createReadStream(path);
    },
    /** Hyperdrive emits no "update": its index core emits "append" (and "truncate" when a writer forks). */
    onChange(cb) {
      raw.core.on("append", cb);
      raw.core.on("truncate", cb);
      return () => {
        raw.core.removeListener("append", cb);
        raw.core.removeListener("truncate", cb);
      };
    },
    stats() {
      return { length: raw.core.length, peers: raw.core.peers?.length ?? 0 };
    },
  };
}

export function createHyperDriveStore(dir: string, log: P2pLog = () => {}): HyperDriveStore {
  const corestore = new Corestore(dir);
  /** The one cache: every open, own or remote, goes through the drive's key. A second Hyperdrive on a held core waits forever. */
  const byKey = new Map<string, Promise<Entry>>();

  async function closeEntry(entry: Entry): Promise<void> {
    byKey.delete(entry.drive.key);
    await entry.raw.close().catch((e: unknown) => {
      log("error", { where: "drive.close", drive: short(entry.drive.key), err: errText(e) });
    });
  }

  async function acquire(key: string, make: () => Promise<Entry>): Promise<Drive> {
    let pending = byKey.get(key);
    if (!pending) {
      pending = make();
      byKey.set(key, pending);
      pending.catch(() => byKey.delete(key));
    }
    const entry = await pending;
    entry.refs++;
    return entry.drive;
  }

  /** Hyperdrive.getDriveKey opens an exclusive session, which waits forever on a drive that is already open; a plain session reads the same key. */
  async function driveKey(store: any): Promise<string> {
    const core = store.get({ name: "db" });
    try {
      await core.ready();
      return toHex(core.key);
    } finally {
      await core.close();
    }
  }

  function track(raw: any): Entry {
    return { raw, drive: wrap(raw), refs: 0 };
  }

  return {
    replicate: (conn) => corestore.replicate(conn as never),
    ready: () => corestore.ready(),
    async openOwn(namespace) {
      await corestore.ready();
      const store = namespace ? corestore.namespace(namespace) : corestore;
      const key = await driveKey(store);
      return acquire(key, async () => {
        /** Closing a Hyperdrive closes the store it was built on: give it a session of its own, never the root. */
        const raw = new Hyperdrive(namespace ? store : store.session());
        await raw.ready();
        return track(raw);
      });
    },
    async open(key, { timeoutMs }) {
      try {
        return [null, await acquire(key, () => openRemote(key, timeoutMs))];
      } catch (e: unknown) {
        return [e instanceof Error ? e : new Error(String(e)), null];
      }
    },
    async release(drive) {
      const entry = await byKey.get(drive.key);
      if (!entry || entry.drive !== drive) return;
      entry.refs--;
      if (entry.refs <= 0) await closeEntry(entry);
    },
    async close() {
      const entries = await Promise.all(
        Array.from(byKey.values(), (p) => p.catch(() => undefined)),
      );
      for (const entry of entries) if (entry) await closeEntry(entry);
      await corestore.close();
    },
  };

  async function openRemote(key: string, timeoutMs: number): Promise<Entry> {
    const raw = new Hyperdrive(corestore.session(), Buffer.from(key, "hex"));
    const startedAt = Date.now();
    log("drive.open.start", { drive: short(key), topic: short(raw.discoveryKey) });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        raw.ready(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("timeout opening remote drive")), timeoutMs);
        }),
      ]);
    } catch (e: unknown) {
      log("drive.open.timeout", { drive: short(key), ms: Date.now() - startedAt, err: errText(e) });
      /** A Hyperdrive holds its core exclusively: an abandoned one would make every later open of this key wait forever. */
      await raw.close().catch(() => {});
      throw e;
    } finally {
      clearTimeout(timer);
    }
    log("drive.open.ready", {
      drive: short(key),
      ms: Date.now() - startedAt,
      peers: raw.core?.peers?.length,
    });
    return track(raw);
  }
}
