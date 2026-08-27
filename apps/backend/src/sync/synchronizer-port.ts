/**
 * #19 first slice — the `SynchronizerPort` seam contract.
 *
 * justus syncs photos peer-to-peer over Hyperdrive today, but that logic lives
 * monolithically inside `photo-store.ts` (corestore + Hyperswarm + manifest /
 * Hyperblobs). #19 re-expresses sync behind a narrow, injectable port so the
 * real hyperdrive-file seam can be swapped in later without touching callers.
 *
 * This file is ONLY the contract plus an in-memory `FakeSynchronizer` whose
 * read-path mirrors the port's specified semantics. It is the literal first
 * #19 acceptance criterion ("Fake port provides parity"): a faithful stand-in
 * so later PRs can write tests against the port and have them pass against the
 * real seam. The running `photo-store.ts` is intentionally untouched by this PR.
 */

/** Metadata for one stored object, as reported by a batch-metadata list. */
export interface EntryMeta {
  /** Object name relative to the drive root (no leading slash). */
  name: string;
  size: number;
  mtime: number;
}

/**
 * A peer that satisfies a folder's sync topic. The real seam lists one entry
 * per connected device and the fake lists none (no swarm), so the field is
 * scoped per topic rather than as a raw connection count.
 */
export interface PeerReport {
  /** Peer device/drive key, hex. */
  key: string;
  /** The swarm topic this peer satisfies (per-topic peers). */
  topic: string;
}

/** A single ranged read request: the half-open byte span [start, end). */
export interface ReadRange {
  start: number;
  end: number;
}

/** One object to write through the port. */
export interface PutInput {
  path: string;
  data: Buffer;
  mtime?: number;
}

/** A handle to one opened drive, scoped to a single folder/identity key. */
export interface DriveHandle {
  readonly key: string;
  /** List entries under `prefix` ("" = root), sorted by name. */
  list(prefix: string): Promise<EntryMeta[]>;
  /** Stat a single object, throwing when the object is absent. */
  stat(filePath: string): Promise<EntryMeta>;
  /** Read a whole object, throwing when the object is absent. */
  read(filePath: string): Promise<Buffer>;
  /** Read a half-open byte range, throwing when out of bounds or absent. */
  readRange(filePath: string, range: ReadRange): Promise<Buffer>;
  /** Peers currently serving this drive, per topic. */
  peers(): PeerReport[];
}

/** The injectable sync seam. Real impl wraps corestore + Hyperswarm. */
export interface SynchronizerPort {
  open(keyHex: string, opts?: { server?: boolean }): Promise<DriveHandle>;
  put(keyHex: string, write: PutInput): Promise<void>;
  close(keyHex: string): Promise<void>;
}

function normalizePath(filePath: string): string {
  const clean = filePath.replace(/^\/+/, "");
  if (clean.length === 0) throw new Error("empty path");
  return clean;
}

/** Create an in-memory synchronizer for tests. Pure Node — no Bare/swarm. */
export function createFakeSynchronizer(opts: { now?: () => number } = {}): SynchronizerPort & {
  /** Inspect a drive's stored objects (test helper only). */
  snapshot(keyHex: string): Map<string, { data: Buffer; mtime: number }>;
} {
  const now = opts.now ?? (() => Date.now());
  const drives = new Map<string, Map<string, { data: Buffer; mtime: number }>>();
  const handles = new Map<string, DriveHandle>();

  function driveOf(keyHex: string): Map<string, { data: Buffer; mtime: number }> {
    let drive = drives.get(keyHex);
    if (!drive) {
      drive = new Map();
      drives.set(keyHex, drive);
    }
    return drive;
  }

  function makeHandle(keyHex: string): DriveHandle {
    const drive = driveOf(keyHex);
    return {
      key: keyHex,
      async list(prefix: string): Promise<EntryMeta[]> {
        const scoped = prefix.replace(/^\/+/, "").replace(/\/$/, "");
        const out: EntryMeta[] = [];
        for (const [name, entry] of drive) {
          if (scoped.length === 0 || name === scoped || name.startsWith(scoped + "/")) {
            out.push({ name, size: entry.data.length, mtime: entry.mtime });
          }
        }
        out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        return out;
      },
      async stat(filePath: string): Promise<EntryMeta> {
        const name = normalizePath(filePath);
        const entry = drive.get(name);
        if (!entry) throw new Error(`no such object: ${name}`);
        return { name, size: entry.data.length, mtime: entry.mtime };
      },
      async read(filePath: string): Promise<Buffer> {
        const name = normalizePath(filePath);
        const entry = drive.get(name);
        if (!entry) throw new Error(`no such object: ${name}`);
        return Buffer.from(entry.data);
      },
      async readRange(filePath: string, { start, end }: ReadRange): Promise<Buffer> {
        const name = normalizePath(filePath);
        const entry = drive.get(name);
        if (!entry) throw new Error(`no such object: ${name}`);
        if (start < 0 || end < start || end > entry.data.length) {
          throw new Error(`range out of bounds: ${start}-${end}`);
        }
        return entry.data.subarray(start, end);
      },
      peers(): PeerReport[] {
        return [];
      },
    };
  }

  return {
    async open(keyHex: string): Promise<DriveHandle> {
      const existing = handles.get(keyHex);
      if (existing) return existing;
      const handle = makeHandle(keyHex);
      handles.set(keyHex, handle);
      return handle;
    },
    async put(keyHex: string, { path, data, mtime }: PutInput): Promise<void> {
      const name = normalizePath(path);
      driveOf(keyHex).set(name, { data: Buffer.from(data), mtime: mtime ?? now() });
    },
    async close(keyHex: string): Promise<void> {
      handles.delete(keyHex);
    },
    snapshot(keyHex: string): Map<string, { data: Buffer; mtime: number }> {
      return driveOf(keyHex);
    },
  };
}
