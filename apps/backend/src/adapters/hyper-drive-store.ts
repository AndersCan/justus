import Corestore from "corestore";
import { short, type P2pLog } from "../p2p-log";
import Hyperdrive from "hyperdrive";
import type { Drive, DriveEntry, DriveStore } from "../ports/drive-store";

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
        yield {
          path: e.key,
          size: e.value?.blob?.byteLength ?? 0,
          metadata: e.value?.metadata ?? {},
        };
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
  const byKey = new Map<string, Entry>();
  const opening = new Map<string, Promise<Entry>>();
  const ownOpening = new Map<string, Promise<Entry>>();
  const ownKeys = new Map<string, string>();

  function track(raw: any): Entry {
    const entry: Entry = { raw, drive: wrap(raw), refs: 0 };
    byKey.set(entry.drive.key, entry);
    return entry;
  }

  async function closeEntry(entry: Entry): Promise<void> {
    byKey.delete(entry.drive.key);
    await entry.raw.close().catch((e: unknown) => {
      log("error", { where: "drive.close", drive: short(entry.drive.key), err: errText(e) });
    });
  }

  async function shared(
    pending: Map<string, Promise<Entry>>,
    id: string,
    make: () => Promise<Entry>,
  ): Promise<Drive> {
    let p = pending.get(id);
    if (!p) {
      p = make();
      pending.set(id, p);
      p.then(
        () => pending.delete(id),
        () => pending.delete(id),
      );
    }
    const entry = await p;
    entry.refs++;
    return entry.drive;
  }

  return {
    replicate: (conn) => corestore.replicate(conn as never),
    ready: () => corestore.ready(),
    async openOwn(namespace) {
      await corestore.ready();
      const id = namespace ?? "";
      const known = ownKeys.get(id);
      const held = known === undefined ? undefined : byKey.get(known);
      if (held) {
        held.refs++;
        return held.drive;
      }
      return shared(ownOpening, id, async () => {
        const raw = new Hyperdrive(namespace ? corestore.namespace(namespace) : corestore);
        await raw.ready();
        const entry = track(raw);
        ownKeys.set(id, entry.drive.key);
        return entry;
      });
    },
    async open(key, { timeoutMs }) {
      const held = byKey.get(key);
      if (held) {
        held.refs++;
        return [null, held.drive];
      }
      try {
        return [null, await shared(opening, key, () => openRemote(key, timeoutMs))];
      } catch (e: unknown) {
        return [e instanceof Error ? e : new Error(String(e)), null];
      }
    },
    async release(drive) {
      const entry = byKey.get(drive.key);
      if (!entry) return;
      entry.refs--;
      if (entry.refs <= 0) await closeEntry(entry);
    },
    async close() {
      for (const entry of Array.from(byKey.values())) await closeEntry(entry);
      await corestore.close();
    },
  };

  async function openRemote(key: string, timeoutMs: number): Promise<Entry> {
    const raw = new Hyperdrive(corestore, Buffer.from(key, "hex"));
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
