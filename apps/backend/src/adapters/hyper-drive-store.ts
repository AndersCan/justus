import { short, type P2pLog } from "../p2p-log";
import type {
  Drive,
  DriveEntry,
  DriveStore,
  IdentityProof,
  IdentitySignature,
  OpenResult,
} from "../ports/drive-store";
import Corestore from "corestore";
import Hypercore from "hypercore";
import crypto from "hypercore-crypto";
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

/** True when `proof` is a signature by the signer of the drive `proof.identityKey`. Never throws. */
function verifyIdentityProof(proof: IdentityProof): boolean {
  try {
    const { identityKey, publicKey, signature, message } = proof;
    if (!/^[0-9a-f]{64}$/i.test(identityKey)) return false;
    if (!/^[0-9a-f]{64}$/i.test(publicKey)) return false;
    if (!/^[0-9a-f]{128}$/i.test(signature)) return false;
    const pub = Buffer.from(publicKey, "hex");
    if (!Hypercore.key(pub).equals(Buffer.from(identityKey, "hex"))) return false;
    return crypto.verify(Buffer.from(message), Buffer.from(signature, "hex"), pub);
  } catch {
    return false;
  }
}

/** Maps a raw Hyperdrive list entry to the port's `DriveEntry`. */
export function toDriveEntry(e: any): DriveEntry {
  return {
    path: e.key,
    size: e.value?.blob?.byteLength ?? 0,
    metadata: e.value?.metadata ?? {},
  };
}

function readOnlyCopy(): never {
  throw new Error("read-only copy");
}

function wrap(raw: any, wrapOpts: { readOnly?: boolean } = {}): Drive {
  const readOnly = wrapOpts.readOnly === true;
  /** The live download of the file index that `keepOnly` starts once. */
  let liveIndex: unknown;
  return {
    key: toHex(raw.key),
    discoveryKey: toHex(raw.discoveryKey),
    async readSmall(path, maxBytes, opts) {
      const readOpts = opts ? { timeout: opts.timeoutMs } : undefined;
      const node = await raw.entry(path, readOpts);
      const size = node?.value?.blob?.byteLength;
      if (typeof size === "number" && size > maxBytes) return undefined;
      /** A blob nobody can serve inside the timeout reads as missing, like an absent path. */
      const bytes = await raw.get(path, readOpts).catch((e: unknown) => {
        if (opts && (e as { code?: string })?.code === "REQUEST_TIMEOUT") return undefined;
        throw e;
      });
      if (bytes === null || bytes === undefined || bytes.byteLength > maxBytes) return undefined;
      // Not TextDecoder: Bare has no global one (#201).
      return Buffer.from(bytes).toString("utf8");
    },
    async readBytes(path) {
      const bytes = await raw.get(path);
      return bytes ?? undefined;
    },
    async put(path, bytes, opts) {
      if (readOnly) readOnlyCopy();
      await raw.put(path, Buffer.from(bytes), opts?.metadata ? { metadata: opts.metadata } : {});
    },
    async del(path) {
      if (readOnly) readOnlyCopy();
      await raw.del(path);
    },
    async clear(path) {
      if (readOnly) readOnlyCopy();
      await raw.clear(path);
    },
    async keepOnly(path): Promise<OpenResult<void>> {
      if (readOnly) readOnlyCopy();
      const missing: OpenResult<void> = [new Error(`${path} is not on this device`), null];
      try {
        const node = await raw.entry(path, { wait: false }).catch(() => undefined);
        const blob = node?.value?.blob;
        if (!blob) return missing;
        const blobs = await raw.getBlobs();
        const { blockOffset, blockLength } = blob;
        if (!(await blobs.core.has(blockOffset, blockOffset + blockLength))) return missing;
        if (blockOffset > 0) await blobs.core.clear(0, blockOffset);
        const end = blobs.core.length;
        if (end > blockOffset + blockLength) await blobs.core.clear(blockOffset + blockLength, end);
        if (!liveIndex) liveIndex = raw.core.download({ start: 0, end: -1 });
        return [null, undefined];
      } catch (e: unknown) {
        return [e instanceof Error ? e : new Error(String(e)), null];
      }
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
      if (readOnly) return () => {};
      raw.core.on("append", cb);
      raw.core.on("truncate", cb);
      return () => {
        raw.core.removeListener("append", cb);
        raw.core.removeListener("truncate", cb);
      };
    },
    version() {
      return raw.version;
    },
    stats() {
      return { length: raw.core.length, peers: raw.core.peers?.length ?? 0 };
    },
    async update() {
      await raw.update();
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

  /** Copies at a version: the checkout to close and the live drive whose ref it holds. */
  const copies = new Map<Drive, { raw: any; live: Drive }>();

  async function open(key: string, timeoutMs: number): Promise<OpenResult<Drive>> {
    try {
      return [null, await acquire(key, () => openRemote(key, timeoutMs))];
    } catch (e: unknown) {
      return [e instanceof Error ? e : new Error(String(e)), null];
    }
  }

  async function release(drive: Drive): Promise<void> {
    const copy = copies.get(drive);
    if (copy) {
      copies.delete(drive);
      await copy.raw.close().catch((e: unknown) => {
        log("error", { where: "drive.close", drive: short(drive.key), err: errText(e) });
      });
      await release(copy.live);
      return;
    }
    const entry = await byKey.get(drive.key);
    if (!entry || entry.drive !== drive) return;
    entry.refs--;
    if (entry.refs <= 0) await closeEntry(entry);
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function openAt(
    key: string,
    version: number,
    timeoutMs: number,
  ): Promise<OpenResult<Drive>> {
    const deadline = Date.now() + timeoutMs;
    const [err, live] = await open(key, timeoutMs);
    if (err || !live) return [err ?? new Error("open returned no drive"), null];
    const raw = (await byKey.get(key))?.raw;
    if (!raw) return [new Error(`drive ${short(key)} was closed while opening a copy`), null];
    while (raw.core.length < version) {
      const left = deadline - Date.now();
      if (left <= 0) {
        await release(live);
        return [new Error(`drive ${short(key)} did not reach version ${version}`), null];
      }
      await Promise.race([raw.update().catch(() => {}), sleep(Math.min(left, 200))]);
      if (raw.core.length < version) await sleep(50);
    }
    const checkout = raw.checkout(version);
    try {
      await checkout.ready();
    } catch (e: unknown) {
      await checkout.close().catch(() => {});
      await release(live);
      return [e instanceof Error ? e : new Error(String(e)), null];
    }
    const copy = wrap(checkout, { readOnly: true });
    copies.set(copy, { raw: checkout, live });
    return [null, copy];
  }

  function track(raw: any): Entry {
    return { raw, drive: wrap(raw), refs: 0 };
  }

  return {
    replicate: (conn) => corestore.replicate(conn as never),
    ready: () => corestore.ready(),
    discoveryKeyOf: (key) => toHex(Hypercore.discoveryKey(Buffer.from(key, "hex"))),
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
    async signAsIdentity(message): Promise<OpenResult<IdentitySignature>> {
      let drive: Drive | undefined;
      try {
        drive = await this.openOwn();
        const raw = (await byKey.get(drive.key))?.raw;
        await raw.ready();
        const kp = raw.core.keyPair;
        if (!kp?.secretKey) return [new Error("identity drive has no secret key"), null];
        const sig = crypto.sign(Buffer.from(message), kp.secretKey);
        return [null, { publicKey: toHex(kp.publicKey), signature: toHex(sig) }];
      } catch (e: unknown) {
        return [e instanceof Error ? e : new Error(String(e)), null];
      } finally {
        if (drive) await release(drive).catch(() => {});
      }
    },
    verifyIdentity: (proof) => verifyIdentityProof(proof),
    open: (key, { timeoutMs }) => open(key, timeoutMs),
    openAt: (key, version, { timeoutMs }) => openAt(key, version, timeoutMs),
    release,
    async purge(key) {
      const pending = byKey.get(key);
      const entry = pending ? await pending.catch(() => undefined) : undefined;
      if (entry) {
        byKey.delete(key);
        entry.refs = 0;
        await entry.raw.purge();
        return;
      }
      const raw = new Hyperdrive(corestore.session(), Buffer.from(key, "hex"));
      try {
        await raw.ready();
        await raw.purge();
      } finally {
        await raw.close().catch(() => {});
      }
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
