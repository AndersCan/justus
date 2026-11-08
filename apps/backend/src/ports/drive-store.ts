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
  /**
   * Keeps this device's copy of `path` and of the drive's file index, now and as the drive
   * grows, so this device can serve `path` while the owner is away; deletes this device's
   * copy of every other file's bytes, also of files a later version deleted. Entries stay.
   * When `path` is the drive's only file and the drive's last write put it, also deletes this
   * device's copy of every older version of the file index, so no older version can be read
   * from or served by this device (`olderVersionsCleared`); a device keeping someone else's
   * drive re-checks this each time the drive grows. Safe to run again, as after a restart.
   * An error value when `path` or its bytes are not on this device. `openAt` copies throw.
   */
  keepOnly(path: string): Promise<OpenResult<{ olderVersionsCleared: boolean }>>;
  list(dir: string): AsyncIterable<DriveEntry>;
  createReadStream(path: string): ByteStream;
  /** Fires on a local write and on a replicated append. Returns an unsubscribe. */
  onChange(cb: () => void): () => void;
  stats(): { length: number; peers: number };
  /** The drive's version now: the length of its file index. */
  version(): number;
  /** Asks peers for newer data. Resolves quietly when there is none or nobody to ask. */
  update(): Promise<void>;
};

export type OpenResult<T> = [Error, null] | [null, T];

/** An ed25519 signature by the identity drive's key pair. Both hex. `publicKey` is not the drive key. */
export type IdentitySignature = { publicKey: string; signature: string };
/** A claim that the identity drive `identityKey` signed `message`. All hex except `message`. */
export type IdentityProof = IdentitySignature & { identityKey: string; message: Uint8Array };

export type DriveStore = {
  ready(): Promise<void>;
  /** Keyless (identity) drive, or the drive of a namespace such as `folder/<id>` or `member/<shareKey>`. */
  openOwn(namespace?: string): Promise<Drive>;
  /** Signs `message` with the identity drive's key pair (the drive `openOwn()` returns). An error value when the store is closed or the drive has no secret key. */
  signAsIdentity(message: Uint8Array): Promise<OpenResult<IdentitySignature>>;
  /** This phone's public key for messages sealed to it (x25519, 64 hex). Derived from the identity key pair: the same after a restart. An error value when the store is closed or the identity drive has no secret key. */
  boxPublicKey(): Promise<OpenResult<string>>;
  /** Seals `message` so only the phone whose `boxPublicKey()` is `boxPublicKey` can open it. Hex. An error value for a key that is not 64 hex. Never throws. */
  sealFor(boxPublicKey: string, message: Uint8Array): OpenResult<string>;
  /** Opens a message sealed to this phone. An error value when it is malformed, sealed to another phone, or the store is closed. Never throws. */
  openSealed(sealed: string): Promise<OpenResult<Uint8Array>>;
  /** True when `signature` is `publicKey`'s signature over `message` and `publicKey` is the signer of the drive whose key is `identityKey`. False, never a throw, for malformed hex. */
  verifyIdentity(proof: IdentityProof): boolean;
  /**
   * Opens a drive by key; an error value when it is not ready within `timeoutMs`.
   * An unserved remote key opens empty (hyperdrive 13.3.3) rather than giving an error.
   */
  open(key: string, opts: { timeoutMs: number }): Promise<OpenResult<Drive>>;
  /**
   * A read-only copy of the drive with this key as it was at `version`. Its `put`, `del` and
   * `clear` throw. Waits up to `timeoutMs` for the copy to reach that version; an error value when
   * it does not. Release it like any other drive; releasing it never closes the live drive.
   */
  openAt(key: string, version: number, opts: { timeoutMs: number }): Promise<OpenResult<Drive>>;
  /** The topic a drive with this key is served on. Known before the drive opens, so a caller can join it first. */
  discoveryKeyOf(key: string): string;
  /** Deletes this device's copy of the drive with this key and closes every handle to it. Other devices' copies are untouched; opening the key again starts empty and fills from peers. */
  purge(key: string): Promise<void>;
  /** Drops one reference; the drive really closes at zero. */
  release(drive: Drive): Promise<void>;
  close(): Promise<void>;
};
