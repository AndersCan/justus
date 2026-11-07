/**
 * The drive storage boundary (#200): everything the app needs from Corestore
 * and Hyperdrive, and nothing else. Keys are lowercase hex strings. Replication
 * is not part of the port: the adapter exposes `replicate` for the composition
 * root to hand to the network.
 */
export type DriveEntry = {
  path: string;
  /** Real byte length of the blob. */
  size: number;
  metadata: Record<string, unknown>;
};

export type ByteStream = {
  on(event: "data" | "end" | "error", listener: (...args: any[]) => void): unknown;
};

export type Drive = {
  key: string;
  discoveryKey: string;
  /** utf8 text, or undefined when missing or larger than `maxBytes`. The size is checked before the blob downloads. */
  readSmall(
    path: string,
    maxBytes: number,
    opts?: { timeoutMs: number },
  ): Promise<string | undefined>;
  readBytes(path: string): Promise<Uint8Array | undefined>;
  put(
    path: string,
    bytes: Uint8Array,
    opts?: { metadata?: Record<string, unknown> },
  ): Promise<void>;
  del(path: string): Promise<void>;
  /** Deletes this device's copy of the file's bytes; the entry stays, and a later read fetches the bytes from a peer again. */
  clear(path: string): Promise<void>;
  list(dir: string): AsyncIterable<DriveEntry>;
  createReadStream(path: string): ByteStream;
  /** Fires on a local write and on a replicated append. Returns an unsubscribe. */
  onChange(cb: () => void): () => void;
  stats(): { length: number; peers: number };
  /** Asks peers for newer data. Resolves quietly when there is none or nobody to ask. */
  update(): Promise<void>;
};

export type OpenResult<T> = [Error, null] | [null, T];

export type DriveStore = {
  ready(): Promise<void>;
  /** Keyless (identity) drive, or the drive of a namespace such as `folder/<id>` or `member/<shareKey>`. */
  openOwn(namespace?: string): Promise<Drive>;
  /**
   * Opens a drive by key; an error value when it is not ready within `timeoutMs`.
   * An unserved remote key opens empty (hyperdrive 13.3.3) rather than giving an error.
   */
  open(key: string, opts: { timeoutMs: number }): Promise<OpenResult<Drive>>;
  /** The topic a drive with this key is served on. Known before the drive opens, so a caller can join it first. */
  discoveryKeyOf(key: string): string;
  /** Deletes this device's copy of the drive with this key and closes every handle to it. Other devices' copies are untouched; opening the key again starts empty and fills from peers. */
  purge(key: string): Promise<void>;
  /** Drops one reference; the drive really closes at zero. */
  release(drive: Drive): Promise<void>;
  close(): Promise<void>;
};
