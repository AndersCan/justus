import Hyperswarm from "hyperswarm";
import { deriveGallery, type DriveScan } from "./gallery-order";
import { pumpStream, type PumpWriter } from "./pump";
import { guessMime } from "./mime";
import { spoolNameFor } from "./spool-name";
import type { LoopbackServer } from "@ekrooh/bare/runtime";
import { CoreError, ErrorCode, err, ok } from "@ekrooh/bare/core";

/**
 * Dependency-injection seam. `photo-store.ts` used to import the full p2p
 * stack (`bare-fs` / `bare-path` / `bare-crypto` / `corestore` / `hyperdrive`)
 * at module top, which pulls in native addons and makes the module impossible
 * to load under Node/vitest (no Bare runtime). Those symbols are now injected
 * through {@link PhotoStoreDeps}, so the module loads without Bare and the
 * drives/corestore/swarm can be substituted with in-memory fakes in tests.
 * Production (`main.core.ts`) passes the real `bare-*` implementations; the
 * only behavior that changes is *where* the constructors are chosen.
 */
type CorestoreLike = {
  ready(): Promise<void>;
  replicate(conn: unknown): void;
  close(): Promise<void>;
};

type SwarmLike = {
  join(
    topic: Buffer,
    opts?: { server?: boolean },
  ): {
    flushed?: () => Promise<void>;
    destroy(): void | Promise<void>;
  };
  on(event: "connection", handler: (conn: unknown) => void): void;
  connections: Set<unknown>;
  destroy(): void | Promise<void>;
};

/** Default swarm factory (used when `deps.makeSwarm` is omitted). */
const defaultSwarm = (opts?: { bootstrap?: string[] }): SwarmLike =>
  new Hyperswarm(opts) as unknown as SwarmLike;
import type {
  FolderSummary,
  JoinRequest,
  Photo,
  PhotoChanged,
  PhotoChangedCause,
  Role,
  SyncMember,
  SyncStatus,
} from "@justus/core";

/** Canonical app-scoped error codes (preserved verbatim on the wire). */
export const PhotoError = {
  NOT_A_MEMBER: "justus.photos/not-a-member",
  NOT_CREATOR: "justus.photos/not-creator",
  ALREADY_ENROLLED: "justus.photos/already-enrolled",
  NOT_FOUND: "justus.photos/not-found",
  INVALID_KEY: "justus.photos/invalid-key",
  FOLDER_NOT_FOUND: "justus.photos/folder-not-found",
  NAME_REQUIRED: "justus.photos/name-required",
  NO_ACTIVE_FOLDER: "justus.photos/no-active-folder",
  NOT_PENDING: "justus.photos/not-pending",
  FORBIDDEN: "justus.photos/import-path-forbidden",
} as const;

/** Any drive handle (the p2p packages ship no types). */
type Drive = any;

/** Success/failure tuple matching the framework's `Either<E, A>` union. */
type EitherResult<T> = [CoreError, null] | [null, T];

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Persisted device state — now MULTI-folder. `name` is the settable user
 * name (surfaced via `status().name` and persisted to each drive's
 * `/device.json`). `folders` is the list of every folder this device belongs
 * to (creator, member or reader). `activeFolderId` points at the single
 * folder the gallery operates on; exactly one folder is active.
 */
type PersistedState = {
  name: string;
  folders: FolderRecord[];
  activeFolderId: string | null;
};

/**
 * One folder this device holds. `id` is a stable local id (across sessions);
 * `shareKey` is the creator drive's key (hex), `driveKey` is the drive THIS
 * device writes within this folder (`""` for pure readers).
 */
type FolderRecord = {
  id: string;
  name: string;
  role: Role;
  /** True while this device's writer enrollment awaits the creator's approval
   * (a requested join). The device can still read by share key regardless. */
  pending?: boolean;
  shareKey: string;
  driveKey: string;
  createdAt: number;
};

type RegistryFile = {
  version: 1;
  members: Record<string, { key: string; name: string; addedAt: number }>;
};

type RemovedFile = {
  version: 1;
  removed: Record<string, { memberKey: string; removedAt: number }>;
};

type PhotoMeta = {
  addedAt: number;
  name: string;
  mime: string;
  sha256?: string;
};

/**
 * Join-request outbox on the REQUESTER's own single-writer drive, keyed by the
 * target folder's share key. `requests()` on the creator side reads this.
 */
type RequestsFile = {
  version: 1;
  requests: Record<
    string,
    {
      requesterKey: string;
      requesterName: string;
      shareKey: string;
      folderName: string;
      requestedAt: number;
    }
  >;
};

export type PhotoStoreDeps = {
  storageDir: string;
  cacheDir: string;
  /** Allowed roots for `add(path)` imports (issue #93/#97). The native picker
   * copies selections into `cacheDir`, so that is the default; production may
   * pass additional roots if the picker is configured to write elsewhere. A
   * path that does not resolve inside one of these roots is rejected before any
   * bytes are read. */
  importRoots?: string[];
  server: LoopbackServer;
  /** This device's display name (persisted; defaults generated). */
  deviceName: string;
  /** Push a backend → web `photos.changed` dispatch. */
  onChanged: (change: PhotoChanged) => void;
  /** Seed sample photos on an empty drive (dev only). */
  seedOnEmpty: boolean;
  /** Hyperswarm DHT bootstrap servers (dev/test: local DHT node). */
  bootstrap?: string[];
  /** Filesystem access. Injected so the store loads under Node/vitest without
   * the Bare runtime; production passes `bare-fs`. */
  fs: typeof import("bare-fs");
  /** Path helpers. Injected; production passes `bare-path`. */
  path: typeof import("bare-path");
  /** Crypto helpers. Injected; production passes `bare-crypto`. */
  crypto: typeof import("bare-crypto");
  /** Builds the Corestore for a storage directory (no Node equivalent). */
  makeCorestore: (dir: string) => CorestoreLike;
  /** Builds a Hyperdrive over a corestore + optional root key. */
  makeDrive: (corestore: unknown, key?: Buffer) => Drive;
  /** Builds the Hyperswarm DHT client. Optional; defaults to `new Hyperswarm`. */
  makeSwarm?: (opts?: { bootstrap?: string[] }) => SwarmLike;
  /** Max ms to wait for a remote drive to become ready before giving up on it
   * (e.g. when reading a peer's join-request outbox in `requests()`). Defaults
   * to 45_000. Test seams lower it so latency regressions surface quickly. */
  driveOpenTimeoutMs?: number;
};

export interface PhotoStore {
  ready(): Promise<void>;
  list(): Promise<Photo[]>;
  add(path: string, name?: string): Promise<EitherResult<Photo>>;
  /** Adds a photo from in-band bytes (browser multi-file picker). */
  addBytes(name: string, bytes: Uint8Array): Promise<EitherResult<Photo>>;
  remove(id: string): Promise<EitherResult<{ id: string }>>;
  join(key: string): Promise<EitherResult<SyncStatus>>;
  enroll(key: string, name: string): Promise<EitherResult<SyncStatus>>;
  status(): Promise<SyncStatus>;
  folders(): Promise<{ folders: FolderSummary[]; activeFolderId: string }>;
  createFolder(name: string): Promise<EitherResult<{ folder: FolderSummary }>>;
  setActive(folderId: string): Promise<EitherResult<SyncStatus>>;
  setName(name: string): Promise<EitherResult<{ name: string }>>;
  requests(): Promise<{ requests: JoinRequest[] }>;
  respond(
    folderId: string,
    requesterKey: string,
    approve: boolean,
  ): Promise<EitherResult<{ ok: boolean }>>;
  close(): Promise<void>;
}

const DRIVE_PATH_PHOTOS = "/photos";
const DRIVE_PATH_DEVICE = "/device.json";
const DRIVE_PATH_MEMBERS = "/members.json";
const DRIVE_PATH_REMOVED = "/removed.json";
const DRIVE_PATH_FOLDER = "/folder.json";
const DRIVE_PATH_REQUESTS = "/requests.json";
const STATE_FILE = "justus.json";

function newId(c: typeof import("bare-crypto")): string {
  return `${Date.now().toString(36)}-${c.randomBytes(4).toString("hex")}`;
}

function hex(buffer: Buffer): string {
  return buffer.toString("hex");
}

function isHexKey(key: string): boolean {
  return /^[0-9a-f]{64}$/i.test(key);
}

/** Decodes standard base64 to bytes. Purpose-built rather than
 * `Buffer.from(s, "base64")` because the bare runtime (ekrooh 0.4.0) rejects
 * otherwise-valid base64 with `Invalid input` at that call site. Portable and
 * dependency-free, so the seed JPEGs boot on every runtime. */
function base64ToBytes(input: string): Uint8Array {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const lookup = new Int8Array(128);
  for (let i = 0; i < chars.length; i++) lookup[chars.charCodeAt(i)] = i;
  const clean = input.replace(/[^A-Za-z0-9+/=]/g, "");
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i++) {
    const c = clean.charCodeAt(i);
    if (clean[i] === "=") break;
    acc = (acc << 6) | lookup[c];
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

function isTextJSON(value: unknown): value is { [k: string]: unknown } {
  return typeof value === "object" && value !== null;
}

type StreamSource = {
  on(event: "data" | "end" | "error", listener: (...args: any[]) => void): unknown;
};

/** Cap on bytes spooled from a drive to the local cache dir (issue #57). A
 * collaborator's drive can carry an oversized "photo"; capping it bounds
 * device-storage use. Mirrors the upload cap in the upload route. */
const MAX_SPOOL_BYTES = 50 * 1024 * 1024;

/** Pumps a source stream into a file, resolving with the byte count. Pass
 * `maxBytes` to fail (and abort) once the stream exceeds it.
 *
 * Delegates to the bare-agnostic, unit-tested {@link pumpStream} (./pump) so
 * the writer's backpressure signal is honored and `maxBytes` is enforced for
 * every caller. The previous inline copy ignored backpressure and the spool
 * path passed no cap (issues #53 and #57). */
export function pumpToFile(
  source: StreamSource,
  destPath: string,
  maxBytes: number | undefined,
  fs: typeof import("bare-fs"),
): Promise<number> {
  return pumpStream(source, {
    createWriter: () => fs.createWriteStream(destPath) as unknown as PumpWriter,
    maxBytes,
  });
}

/**
 * Per-folder open handles + the derived-gallery machinery that used to be
 * global on the single-folder store. One runtime per folder; a folder stays
 * open (its member drives + swarm topics) even while another folder is active,
 * so switching back costs nothing but a remount.
 */
type FolderRuntime = {
  record: FolderRecord;
  /** The folder's share drive (creator drive): holds members.json, removed.json,
   * folder.json + the creator's own photos. */
  folderDrive: Drive;
  /** The drive THIS device writes photos to inside this folder. For a creator
   * folder this is `folderDrive` itself; for a joined member it is the device's
   * own drive; empty/absent for pure readers. */
  selfDrive: Drive;
  /** Registered writer drives other than this device, opened read-only. */
  memberDrives: Map<string, Drive>;
  memberNameCache: Map<string, string>;
  /** Loopback mount routes served for this folder's photos. */
  mounted: Set<string>;
  /** `remove` closures for this folder's `drive.on("update")` watchers, drained
   * on unmount/close so inactive folders stop firing `onChanged` (#46). */
  watcherRemoves: Set<() => void>;
  social: {
    /** Peers seen on this folder's topic since we joined it. Keys are the raw
     * `remotePublicKey` hex from swarm connections. */
    peers: Set<string>;
  };
};

export function createPhotoStore(deps: PhotoStoreDeps): PhotoStore {
  const fs = deps.fs;
  const path = deps.path;
  const crypto = deps.crypto;
  // #93/#97: `add(path)` must only import files the picker actually placed in
  // an allowed root (the native picker copies selections into `cacheDir`).
  const importRoots = deps.importRoots ?? [deps.cacheDir];
  /** True when `resolved` is `root` itself or nested under it; avoids prefix
   * false-positives (e.g. `/cache` matching `/cache-evil`). */
  const isWithinRoot = (resolved: string, root: string): boolean => {
    const r = path.resolve(root);
    const p = path.resolve(resolved);
    return p === r || p.startsWith(r + path.sep);
  };
  /**
   * Contain imports so a symlink cannot *escape* an allowed root. The walk
   * starts at the matched root boundary — not at `/` — so a symlinked ancestor
   * of the root (normal on macOS: `/tmp` -> `/private/tmp`, `/var` ->
   * `/private/var`, or any symlinked mount) is never flagged. A symlink *inside*
   * the root is only rejected when following it leaves every allowed root.
   * Uses lstat + readlinkSync (realpathSync is unavailable in bare-fs) so the
   * link is never followed.
   */
  const assertNoSymlink = (resolved: string, root: string): void => {
    const rootResolved = path.resolve(root);
    // Walk only the components strictly *inside* the matched root (the root
    // directory itself is not re-checked).
    const tail =
      resolved === rootResolved
        ? ""
        : resolved.startsWith(rootResolved + path.sep)
          ? resolved.slice(rootResolved.length + path.sep.length)
          : resolved;
    const parts = tail.split(path.sep).filter(Boolean);
    let acc: string = rootResolved;
    for (const part of parts) {
      acc = path.join(acc, part);
      let st: ReturnType<typeof fs.lstatSync>;
      try {
        st = fs.lstatSync(acc);
      } catch {
        throw new Error("unresolvable path component");
      }
      if (st.isSymbolicLink()) {
        // Reject only when following the link would leave every allowed root.
        const target = fs.readlinkSync(acc);
        const targetResolved = path.resolve(path.dirname(acc), target);
        if (!importRoots.some((r) => isWithinRoot(targetResolved, r))) {
          throw new Error("symlink escapes allowed root");
        }
      }
    }
  };
  const corestore = deps.makeCorestore(path.join(deps.storageDir, "corestore"));
  const swarm: SwarmLike = (deps.makeSwarm ?? defaultSwarm)(
    deps.bootstrap ? { bootstrap: deps.bootstrap } : undefined,
  );
  const stateFile = path.join(deps.storageDir, STATE_FILE);

  let state: PersistedState = loadState();
  /** The device's single identity drive: `/device.json`, and the drive a joined
   * member writes its photos to. Also the drive of the FIRST creator folder. */
  let ownDrive: Drive;
  const runtimes = new Map<string, FolderRuntime>();
  /** Requester keys the creator denied this session. Denials write no durable
   * state (the request only lives on the requester's own drive), so a denied
   * requester would otherwise re-surface in `requests()` every time it re-files
   * a join request (issue #85). We remember denials in-memory for the session. */
  const deniedRequesters = new Set<string>();
  // Swarm topic joins keyed by discoveryKey hex (issue #95). A Map (not an
  // array) lets us make `joinTopic` idempotent — the same topic always returns
  // the same handle — and lets `leaveTopic` reclaim a handle on unmount so a
  // folder switch / re-enroll doesn't leak one join per member drive.
  const joins = new Map<string, { destroy(): void | Promise<void> }>();
  let readyPromise: Promise<void> | null = null;

  /**
   * Content index (issue #43): sha256 → the photos carrying those bytes, so
   * `add`'s content dedupe no longer re-scans every drive (which silently skips
   * unreachable peers and let a re-add of our own bytes slip through). Seeded
   * best-effort from the drives we can see and kept current on add/remove; it is
   * never evicted when a drive is merely unreachable, so a momentary outage
   * can't defeat the dedupe.
   */
  type IndexedPhoto = {
    id: string;
    driveKey: string;
    /** The folder this photo belongs to. Dedupe is scoped per folder (issue
     * #156): several folders can share `ownDrive.key` (the identity folder and
     * any member folder joined on the same device), so keying only on driveKey
     * made a re-add of identical bytes to a *different* folder wrongly return a
     * prior folder's spool entry and silently skip writing the bytes. */
    folderId: string;
    name: string;
    mime: string;
    size: number;
    addedAt: number;
    sha256: string;
    /** Extension (incl. leading dot) — needed to re-derive the spool name when
     * a re-add of the same bytes is served from the content index (issues
     * #81/#83/#87). */
    ext: string;
  };
  const contentIndex = new Map<string, IndexedPhoto[]>();

  function loadState(): PersistedState {
    try {
      const raw = fs.readFileSync(stateFile, "utf8");
      const parsed = JSON.parse(raw);
      if (isTextJSON(parsed)) {
        const name = typeof parsed.name === "string" ? parsed.name : deps.deviceName;
        const activeFolderId =
          typeof parsed.activeFolderId === "string" ? parsed.activeFolderId : null;
        const rawFolders = Array.isArray(parsed.folders) ? (parsed.folders as unknown[]) : [];
        const folders: FolderRecord[] = [];
        for (const f of rawFolders) {
          if (
            isTextJSON(f) &&
            typeof f.id === "string" &&
            typeof f.name === "string" &&
            typeof f.shareKey === "string" &&
            typeof f.driveKey === "string"
          ) {
            folders.push({
              id: f.id,
              name: f.name,
              role: (typeof f.role === "string" ? f.role : "reader") as Role,
              // Carry the pending (awaiting-approval) flag so a requested join
              // keeps its badge after a restart (#94). `saveState` already
              // serializes it; only loadState was dropping it.
              pending: typeof f.pending === "boolean" ? f.pending : false,
              shareKey: f.shareKey,
              driveKey: f.driveKey,
              createdAt: typeof f.createdAt === "number" ? f.createdAt : 0,
            });
          }
        }
        return { name, folders, activeFolderId };
      }
    } catch {
      // Fresh state.
    }
    return { name: deps.deviceName, folders: [], activeFolderId: null };
  }

  function saveState() {
    try {
      fs.writeFileSync(stateFile, JSON.stringify(state));
    } catch (e) {
      const message = errMsg(e);
      console.error(`[justus] failed to persist state: ${message}`);
    }
  }

  async function getText(drive: Drive, drivePath: string): Promise<string | null> {
    try {
      const value = await drive.get(drivePath);
      if (value === null || value === undefined) return null;
      return new TextDecoder().decode(value as Uint8Array);
    } catch {
      return null;
    }
  }

  async function readDeviceName(drive: Drive): Promise<string> {
    const text = await getText(drive, DRIVE_PATH_DEVICE);
    let name = "Unknown device";
    if (text) {
      try {
        const parsed = JSON.parse(text) as { name?: unknown };
        if (typeof parsed.name === "string") name = parsed.name;
      } catch {
        // non-JSON — fall through
      }
    }
    return name;
  }

  async function ensureOwnDriveIdentity() {
    const text = await getText(ownDrive, DRIVE_PATH_DEVICE);
    if (text === null) {
      await ownDrive.put(DRIVE_PATH_DEVICE, Buffer.from(JSON.stringify({ name: state.name })));
    }
  }

  function watchDrive(drive: Drive, folderId: string, label: string, cause: PhotoChangedCause) {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const handler = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const rt = runtimes.get(folderId);
        // A member whose join was approved since we last ran is now a member —
        // re-read the registry and upgrade reader → member in-session (issue
        // #52) instead of waiting for a restart.
        if (rt && rt.record.role === "reader") {
          // Best-effort background upgrade; never block the watcher. Guard the
          // promise so a rejection (e.g. registry read failing) can't become an
          // unhandled rejection that crashes the process.
          void upgradePendingRole(rt).catch(() => {});
        }
        // Drive metadata changed locally or via replication — the gallery is
        // derived, so a refresh always suffices.
        deps.onChanged({ cause, folderId, memberKey: label });
      }, 400);
    };
    drive.on("update", handler);
    const remove = () => {
      drive.removeListener("update", handler);
      if (timer) clearTimeout(timer);
    };
    const rt = runtimes.get(folderId);
    rt?.watcherRemoves.add(remove);
  }

  function armFolderWatchers(rt: FolderRuntime) {
    for (const remove of rt.watcherRemoves) {
      try {
        remove();
      } catch {
        // already removed
      }
    }
    rt.watcherRemoves.clear();
    watchDrive(
      rt.folderDrive,
      rt.record.id,
      hex(rt.folderDrive.key),
      rt.record.role === "creator" ? "enroll" : "add",
    );
    if (rt.selfDrive) watchDrive(rt.selfDrive, rt.record.id, hex(rt.selfDrive.key), "enroll");
    for (const [key, drive] of rt.memberDrives) {
      watchDrive(drive, rt.record.id, key, "add");
    }
  }

  async function joinTopic(topic: Buffer, opts?: { server?: boolean }) {
    const key = hex(topic);
    const existing = joins.get(key);
    if (existing) return existing;
    const handle = swarm.join(topic, opts);
    joins.set(key, handle);
    // Fire-and-forget: never block setup on DHT bootstrap — the app must
    // boot and serve the gallery even when the swarm is unreachable.
    void handle.flushed?.().catch(() => {});
    return handle;
  }

  /** Leaves a previously-joined swarm topic, releasing its handle. No-op if the
   * topic was never joined (or was already left). */
  function leaveTopic(keyHex: string) {
    const handle = joins.get(keyHex);
    if (!handle) return;
    joins.delete(keyHex);
    try {
      const d = handle.destroy?.();
      // `destroy` may return a promise; swallow a rejection so leaving a topic
      // can't raise an unhandled rejection. A sync throw (already destroyed) is
      // already caught by the surrounding try/catch.
      if (d instanceof Promise) d.catch(() => {});
    } catch {
      // already destroyed
    }
  }

  /** Opens a drive by key, joining its swarm topic first so peers serve its
   * blocks (a remote `drive.ready()` otherwise waits forever). */
  async function openDriveWithTopic(keyHex: string, opts?: { server?: boolean }): Promise<Drive> {
    const drive = deps.makeDrive(corestore, Buffer.from(keyHex, "hex"));
    const topic = drive.discoveryKey;
    await joinTopic(topic, opts);
    await Promise.race([
      drive.ready(),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("timeout opening remote drive")),
          deps.driveOpenTimeoutMs ?? 45_000,
        ),
      ),
    ]);
    return drive;
  }

  async function readRegistryIn(drive: Drive): Promise<RegistryFile> {
    const text = await getText(drive, DRIVE_PATH_MEMBERS);
    if (text === null) return { version: 1, members: {} };
    try {
      const parsed = JSON.parse(text) as { version?: unknown; members?: unknown };
      if (parsed.version === 1 && isTextJSON(parsed.members)) {
        return { version: 1, members: parsed.members as RegistryFile["members"] };
      }
    } catch {
      // malformed
    }
    return { version: 1, members: {} };
  }

  async function readRemovedIn(drive: Drive): Promise<RemovedFile["removed"]> {
    const text = await getText(drive, DRIVE_PATH_REMOVED);
    if (text === null) return {};
    try {
      const parsed = JSON.parse(text) as { version?: unknown; removed?: unknown };
      if (parsed.version === 1 && isTextJSON(parsed.removed)) {
        return parsed.removed as RemovedFile["removed"];
      }
    } catch {
      // malformed
    }
    return {};
  }

  async function readFolderNameIn(drive: Drive): Promise<string> {
    const text = await getText(drive, DRIVE_PATH_FOLDER);
    if (text === null) return "";
    try {
      const parsed = JSON.parse(text) as { version?: unknown; name?: unknown };
      if (parsed.version === 1 && typeof parsed.name === "string") return parsed.name;
    } catch {
      // malformed
    }
    return "";
  }

  function activeFolderId(): string | null {
    if (state.activeFolderId && state.folders.some((f) => f.id === state.activeFolderId)) {
      return state.activeFolderId;
    }
    return state.folders.length > 0 ? state.folders[0].id : null;
  }

  function activeRuntime(): FolderRuntime | null {
    const id = activeFolderId();
    return id ? (runtimes.get(id) ?? null) : null;
  }

  /** Spool dir for a folder (per-folder so switching active never serves stale
   * bytes from another folder). */
  function spoolDirFor(folderId: string): string {
    return path.join(deps.cacheDir, "photos", folderId);
  }

  /** Base file names under the photos dir of a drive (sans the dir prefix);
   * empty when the drive isn't downloaded yet. */
  async function drivePhotoKeys(drive: Drive): Promise<string[]> {
    const keys: string[] = [];
    try {
      const list = drive.list(DRIVE_PATH_PHOTOS);
      for await (const entry of list) {
        keys.push((entry as { key: string }).key.slice(DRIVE_PATH_PHOTOS.length + 1));
      }
    } catch {
      // Drive not downloaded yet — empty.
    }
    return keys;
  }

  async function loadMemberDrive(rt: FolderRuntime, keyHex: string, name?: string) {
    if (rt.memberDrives.has(keyHex)) return;
    const selfKey = rt.record.role === "creator" ? hex(rt.folderDrive.key) : hex(ownDrive.key);
    if (keyHex === selfKey) return;
    try {
      const drive = await openDriveWithTopic(keyHex, { server: false });
      rt.memberDrives.set(keyHex, drive);
      if (name) rt.memberNameCache.set(keyHex, name);
      watchDrive(drive, rt.record.id, keyHex, "add");
    } catch (e) {
      const message = errMsg(e);
      console.error(`[justus] failed to open member drive ${keyHex.slice(0, 12)}: ${message}`);
    }
  }

  async function refreshMembersFor(rt: FolderRuntime) {
    const registry = await readRegistryIn(rt.folderDrive);
    const entries = Object.values(registry.members).map((m) => ({
      key: m.key,
      name: m.name,
    }));
    const selfKey = rt.record.role === "creator" ? hex(rt.folderDrive.key) : hex(ownDrive.key);
    const live = new Set(entries.map((e) => e.key));
    live.add(selfKey);
    for (const [key, drive] of rt.memberDrives) {
      if (live.has(key)) continue;
      rt.memberDrives.delete(key);
      rt.memberNameCache.delete(key);
      try {
        await drive.close();
      } catch {
        // already closed
      }
    }
    for (const entry of entries) {
      await loadMemberDrive(rt, entry.key, entry.name);
    }
    // Seed the content index from whatever drives are currently reachable. A
    // drive that is offline is skipped (its entries are already indexed from
    // when it was reachable) — never evicted.
    await seedContentIndex(rt);
  }

  /** Records a photo in the content index so a later re-add dedupes even when
   * the owning drive is momentarily unreachable (issue #43). Idempotent on
   * (sha256, driveKey, id). */
  function indexPhoto(p: IndexedPhoto) {
    const arr = contentIndex.get(p.sha256) ?? [];
    if (arr.some((e) => e.driveKey === p.driveKey && e.id === p.id && e.folderId === p.folderId)) {
      return;
    }
    arr.push(p);
    contentIndex.set(p.sha256, arr);
  }

  /** Drops a photo from the content index once it is removed. */
  function pruneIndex(photoId: string, driveKey: string) {
    for (const arr of contentIndex.values()) {
      const i = arr.findIndex((e) => e.id === photoId && e.driveKey === driveKey);
      if (i >= 0) arr.splice(i, 1);
    }
  }

  /** Best-effort (re)build of the content index from the drives we can currently
   * see. Drives that throw on `list` (unreachable / not downloaded) are skipped,
   * leaving their already-indexed entries intact — that is the whole point of the
   * index: dedupe must not depend on every peer being reachable at add time. */
  async function seedContentIndex(rt: FolderRuntime) {
    const role = rt.record.role;
    const drives: Drive[] = [];
    if (role === "creator" || role === "member") {
      drives.push(role === "creator" ? rt.folderDrive : ownDrive);
    }
    if (role === "reader" || role === "member") {
      drives.push(rt.folderDrive);
    }
    for (const d of rt.memberDrives.values()) drives.push(d);
    const scans: DriveScan[] = [];
    for (const d of drives) {
      try {
        const entries: DriveScan["entries"] = [];
        const list = d.list(DRIVE_PATH_PHOTOS);
        for await (const entry of list) entries.push(entry as never);
        scans.push({ key: hex(d.key), entries });
      } catch {
        // Unreachable drive — its entries are already indexed; skip, don't evict.
        continue;
      }
    }
    const derived = deriveGallery(scans, {}, (k) => rt.memberNameCache.get(k) ?? state.name);
    for (const p of derived) {
      if (!p.sha256) continue;
      indexPhoto({
        id: p.id,
        driveKey: p.driveKey,
        folderId: rt.record.id,
        name: p.name,
        mime: p.mime,
        size: p.size,
        addedAt: p.addedAt,
        sha256: p.sha256,
        ext: p.ext,
      });
    }
  }

  /** Re-derive a pending `reader` folder's role when the creator has since
   * approved the join: if this device is now listed in the folder's registry,
   * flip `reader` → `member` in-session and announce the upgrade (issue #52).
   * Returns true when an upgrade happened. No-op for non-reader folders or
   * folders still awaiting approval. Cheap — reads a single registry file. */
  async function upgradePendingRole(rt: FolderRuntime): Promise<boolean> {
    if (rt.record.role !== "reader") return false;
    const registry = await readRegistryIn(rt.folderDrive);
    const ownKey = hex(ownDrive.key);
    const enrolled = Object.values(registry.members).some((m) => m.key === ownKey);
    if (!enrolled) return false;
    rt.record.role = "member";
    rt.record.pending = false;
    rt.record.driveKey = ownKey;
    rt.selfDrive = ownDrive;
    await refreshMembersFor(rt);
    deps.onChanged({ cause: "enroll", folderId: rt.record.id, memberKey: ownKey });
    return true;
  }

  async function unmountRuntime(rt: FolderRuntime) {
    for (const remove of rt.watcherRemoves) {
      try {
        remove();
      } catch {
        // already removed
      }
    }
    rt.watcherRemoves.clear();
    for (const route of rt.mounted) {
      try {
        deps.server.unmount(route);
      } catch (e) {
        const message = errMsg(e);
        console.error(`[justus] unmount failed for ${route}: ${message}`);
      }
    }
    rt.mounted.clear();
    // Issue #95: tear down this folder's member-drive swarm joins (and close
    // the drives) on unmount so a folder switch or re-enroll doesn't leak one
    // join per member. The device-identity `ownDrive` join is never present
    // here — `loadMemberDrive` skips selfKey — so it is preserved across
    // folder switches.
    for (const drive of rt.memberDrives.values()) {
      leaveTopic(hex(drive.discoveryKey));
      try {
        await drive.close();
      } catch {
        // already closed
      }
    }
    rt.memberDrives.clear();
    rt.memberNameCache.clear();
    const spool = spoolDirFor(rt.record.id);
    try {
      fs.rmSync(spool, { recursive: true, force: true });
    } catch {
      // already gone
    }
  }

  async function listPhotosIn(rt: FolderRuntime): Promise<Photo[]> {
    const removed = await readRemovedIn(rt.folderDrive);
    const role = rt.record.role;
    const creatorKey = hex(rt.folderDrive.key);
    const selfKey = role === "creator" ? creatorKey : hex(ownDrive.key);

    // drivesToScan collects every drive whose /photos dir makes up the derived
    // gallery for this folder + role:
    //  - creator: its own drive (== the folder drive) of creator photos.
    //  - member: its own drive (photos it added) + the creator drive + writers.
    //  - reader: the creator drive + writers (read-only view).
    const drivesToScan: Array<{ key: string; drive: Drive }> = [];
    const seen = new Set<string>();
    const addScan = (key: string, drive: Drive) => {
      if (seen.has(key)) return;
      seen.add(key);
      if (key === creatorKey) {
        drivesToScan.unshift({ key, drive });
      } else {
        drivesToScan.push({ key, drive });
      }
    };

    if (role === "creator" || role === "member") {
      addScan(selfKey, role === "creator" ? rt.folderDrive : ownDrive);
    }
    if (role === "reader" || role === "member") {
      addScan(creatorKey, rt.folderDrive);
    }
    for (const [key, drive] of rt.memberDrives) {
      addScan(key, drive);
    }

    const driveByKey = new Map(drivesToScan.map((s) => [s.key, s.drive]));

    // Raw scans only — parsing, tombstones, dedupe, and canonical order are
    // the pure derivation's job (gallery-order.ts), so this host function
    // cannot drift from the invariants tested there.
    const scans: DriveScan[] = [];
    for (const { key, drive } of drivesToScan) {
      try {
        const entries: DriveScan["entries"] = [];
        const list = drive.list(DRIVE_PATH_PHOTOS);
        for await (const entry of list) entries.push(entry as never);
        scans.push({ key, entries });
      } catch {
        // Drive not downloaded yet — skip.
        continue;
      }
    }

    // Resolve member names up-front so the derivation stays a pure sync
    // function of record data.
    const memberNames = new Map<string, string>();
    for (const { key, drive } of drivesToScan) {
      if (key === selfKey) memberNames.set(key, state.name);
      else memberNames.set(key, rt.memberNameCache.get(key) ?? (await readDeviceName(drive)));
    }

    const photos: Photo[] = [];
    for (const d of deriveGallery(scans, removed, (k) => memberNames.get(k) ?? "Unknown device")) {
      const drive = driveByKey.get(d.driveKey);
      if (!drive) continue;
      // `d.id`/`d.ext` derive from untrusted drive photo keys, so the spool
      // name must be filesystem-safe — never interpolate them raw (issue #71).
      const spoolName = spoolNameFor(d.driveKey, d.id, d.ext);
      const mount = `/photos/${rt.record.id}/${spoolName}`;
      const spoolPath = path.join(spoolDirFor(rt.record.id), spoolName);
      try {
        await spoolToFile(drive, `${DRIVE_PATH_PHOTOS}/${d.id}${d.ext}`, spoolPath);
        if (!rt.mounted.has(mount)) {
          deps.server.mount(mount, spoolPath);
          rt.mounted.add(mount);
        }
      } catch (e) {
        const message = errMsg(e);
        console.error(`[justus] spool failed for ${d.id}${d.ext}: ${message}`);
        continue;
      }
      photos.push({
        id: d.id,
        url: `${await deps.server.origin()}${mount}`,
        name: d.name,
        mime: d.mime,
        size: d.size,
        addedAt: d.addedAt,
        member: { key: d.driveKey, name: d.memberName },
        ...(d.sha256 ? { sha256: d.sha256 } : {}),
      });
    }
    return photos;
  }

  async function spoolToFile(drive: Drive, drivePath: string, spoolPath: string) {
    if (fs.existsSync(spoolPath)) return;
    fs.mkdirSync(path.dirname(spoolPath), { recursive: true });
    // Unique tmp per call so concurrent spools of the same photo never collide;
    // rename is atomic (last write wins, content is identical).
    const tmp = `${spoolPath}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    let ok = false;
    try {
      const stream = drive.createReadStream(drivePath);
      await pumpToFile(stream, tmp, MAX_SPOOL_BYTES, fs);
      fs.renameSync(tmp, spoolPath);
      ok = true;
    } finally {
      if (!ok) {
        // A failed or oversized/capped spool (e.g. a malicious photo past
        // MAX_SPOOL_BYTES, or a disk error) must not leave its staging file
        // behind — clean it up so the cache spool dir never accumulates orphan
        // `*.tmp` files (issues #90/#92). The writer opens its destination file
        // asynchronously, so a fast failure can race the open: the synchronous
        // unlink below sees ENOENT (file not yet on disk) while the open still
        // completes and creates it afterwards. Remove it now and again on the
        // next tick to catch that late open — this is the load-dependent CI
        // flake reported in #142.
        try {
          fs.unlinkSync(tmp);
        } catch {
          // already gone
        }
        setImmediate(() => {
          try {
            fs.unlinkSync(tmp);
          } catch {
            // already gone
          }
        });
      }
    }
  }

  async function seedSamplePhotos(drive: Drive) {
    try {
      const list = drive.list(DRIVE_PATH_PHOTOS);
      for await (const _ of list) return; // non-empty — already seeded
    } catch {
      // empty
    }
    const samples = [
      { name: "sunset.jpg", data: SAMPLE_1, mime: "image/jpeg" },
      { name: "peaks.jpg", data: SAMPLE_2, mime: "image/jpeg" },
      { name: "lake.jpg", data: SAMPLE_3, mime: "image/jpeg" },
    ];
    const addedAt = Date.now() - samples.length * 60_000;
    for (const [i, sample] of samples.entries()) {
      const id = newId(deps.crypto);
      await drive.put(`${DRIVE_PATH_PHOTOS}/${id}.jpg`, sample.data, {
        metadata: { addedAt: addedAt + i * 60_000, name: sample.name, mime: sample.mime },
      });
    }
    console.log("[justus] seeded sample photos");
  }

  async function addFromPath(
    filePath: string,
    originalName?: string,
  ): Promise<EitherResult<Photo>> {
    const rt = activeRuntime();
    if (!rt) return err(PhotoError.NO_ACTIVE_FOLDER, "No folder is active");
    if (rt.record.role === "reader") {
      return err(PhotoError.NOT_A_MEMBER, "Readers cannot add photos");
    }
    // #93/#97: contain the import path before reading any bytes. Normalize
    // `..`/relative segments (path.resolve) and reject anything that escapes an
    // allowed root (the native picker copies selections into `cacheDir`), then
    // reject any symlink component (which could point outside the root). The
    // symlink walk uses lstat so neither the final entry nor an ancestor is
    // followed. A missing file falls through to NOT_FOUND below.
    const resolved = path.resolve(filePath);
    const matchedRoot = importRoots.find((root) => isWithinRoot(resolved, root));
    if (!matchedRoot) {
      return err(PhotoError.FORBIDDEN, `Import path escapes allowed roots: ${filePath}`);
    }
    try {
      assertNoSymlink(resolved, matchedRoot);
    } catch {
      return err(PhotoError.FORBIDDEN, `Import path contains a symlink: ${filePath}`);
    }
    let stat: ReturnType<typeof fs.statSync>;
    try {
      stat = fs.statSync(resolved);
    } catch {
      return err(PhotoError.NOT_FOUND, `No file at ${filePath}`);
    }
    if (!stat.isFile()) {
      return err(PhotoError.NOT_FOUND, `Not a file: ${filePath}`);
    }
    let bytes: import("bare-buffer").Buffer;
    try {
      bytes = fs.readFileSync(resolved) as unknown as import("bare-buffer").Buffer;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return err(ErrorCode.HOST_ERROR, `Failed to read file: ${message}`);
    }
    // The original filename travels in via `originalName` (e.g. the real name
    // of an in-band `addBytes` upload, which is otherwise lost because the bytes
    // are staged to a transient `upload-<id>` file — issue #82). Fall back to
    // the staged file's basename only when no name was supplied (the
    // host-picked `add(path)` flow, where basename is the real name).
    const name =
      originalName && originalName.trim() ? originalName.trim() : path.basename(resolved);
    const ext = path.extname(name).toLowerCase().replace(/^\.$/, "");
    const mime = guessMime(ext);
    // Content dedupe (#20): the same bytes must not create a second entry.
    // bare-crypto's HashAlgorithm spells it "sha-256" at the type level.
    const sha256 = crypto.createHash("sha-256").update(bytes).digest("hex");
    // Reachability-independent content dedupe (issue #43): consult the
    // in-session content index instead of re-scanning every drive (which silently
    // skips unreachable peers and would let a re-add of our own bytes slip
    // through). Only a copy this device already holds short-circuits the add — a
    // matching sha256 on *another* member's drive must NOT be adopted (issue
    // #49): that would leave the "added" photo unowned and unremovable for us, so
    // we fall through and write a local copy below.
    const selfKeyHex = hex(rt.record.role === "creator" ? rt.folderDrive.key : ownDrive.key);
    const ownIdx = contentIndex
      .get(sha256)
      ?.find((e) => e.driveKey === selfKeyHex && e.folderId === rt.record.id);
    if (ownIdx) {
      // Serve the same spool file the original add wrote, so the re-add's URL
      // matches what `listPhotosIn` derives (issues #81/#83/#87).
      const spoolName = spoolNameFor(ownIdx.driveKey, ownIdx.id, ownIdx.ext);
      const mount = `/photos/${rt.record.id}/${spoolName}`;
      const spoolPath = path.join(spoolDirFor(rt.record.id), spoolName);
      if (!rt.mounted.has(mount)) {
        try {
          deps.server.mount(mount, spoolPath);
          rt.mounted.add(mount);
        } catch {
          // mount is best-effort
        }
      }
      return ok({
        id: ownIdx.id,
        url: `${await deps.server.origin()}${mount}`,
        name: ownIdx.name,
        mime: ownIdx.mime,
        size: ownIdx.size,
        addedAt: ownIdx.addedAt,
        member: { key: ownIdx.driveKey, name: state.name },
        ...(ownIdx.sha256 ? { sha256: ownIdx.sha256 } : {}),
      });
    }
    const id = newId(deps.crypto);
    const drivePath = `${DRIVE_PATH_PHOTOS}/${id}${ext}`;
    const metadata: PhotoMeta = { addedAt: Date.now(), name, mime, sha256 };
    // A creator writes to the folder's own drive; a member writes to its own
    // drive (still within the same folder's derived view).
    const targetDrive = rt.record.role === "creator" ? rt.folderDrive : ownDrive;
    const selfKey = hex(targetDrive.key);
    try {
      await targetDrive.put(drivePath, bytes, { metadata });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return err(ErrorCode.PLUGIN_ERROR, `Failed to store photo: ${message}`);
    }
    // Record the new content in the index so a later re-add dedupes even if this
    // drive is momentarily unreachable at that moment (issue #43).
    indexPhoto({
      id,
      driveKey: selfKey,
      folderId: rt.record.id,
      name,
      mime,
      size: stat.size,
      addedAt: metadata.addedAt,
      sha256,
      ext,
    });
    // Spool under the same name `listPhotosIn` derives (#71/#73), so an added
    // photo is served from one spool file and its add-URL matches its list-URL
    // (issues #81/#83/#87). The legacy `selfKey.slice(0,12)-id` name diverged
    // from `spoolNameFor`, orphaning the spool file and returning a stale URL.
    const spoolName = spoolNameFor(selfKey, id, ext);
    const spoolPath = path.join(spoolDirFor(rt.record.id), spoolName);
    try {
      await spoolToFile(targetDrive, drivePath, spoolPath);
    } catch {
      // spool failure is non-fatal — the drive has the bytes
    }
    const mount = `/photos/${rt.record.id}/${spoolName}`;
    if (!rt.mounted.has(mount)) {
      deps.server.mount(mount, spoolPath);
      rt.mounted.add(mount);
    }
    deps.onChanged({ cause: "add", folderId: rt.record.id, memberKey: selfKey });
    return ok({
      id,
      url: `${await deps.server.origin()}${mount}`,
      name,
      mime,
      size: stat.size,
      addedAt: metadata.addedAt,
      member: { key: selfKey, name: state.name },
    });
  }

  function toSummary(rt: FolderRuntime): FolderSummary {
    const role = rt.record.role;
    const driveKey =
      role === "creator" ? hex(rt.folderDrive.key) : role === "member" ? hex(ownDrive.key) : "";
    // The member drives `refreshMembersFor` opened are exactly the other
    // enrolled members' drives (self is skipped in `loadMemberDrive`). For a
    // reader the same set is the writers it can see — so derive the count from
    // it rather than hard-coding 0 (issue #89). `memberDrives` is a `Map`, so
    // use `.size` (not `Object.values`, which is always empty for a Map).
    const memberCount =
      role === "creator" || role === "member" ? rt.memberDrives.size + 1 : rt.memberDrives.size;
    return {
      id: rt.record.id,
      name: rt.record.name,
      role,
      pending: Boolean(rt.record.pending),
      shareKey: rt.record.shareKey,
      driveKey,
      members: memberCount,
      addedAt: rt.record.createdAt,
    };
  }

  async function computeStatus(): Promise<SyncStatus> {
    const rt = activeRuntime();
    if (!rt) {
      // No folder yet — report an empty-but-valid status with the device name.
      return {
        folder: {
          id: "",
          name: "",
          role: "reader",
          shareKey: "",
          driveKey: "",
          members: 0,
          addedAt: 0,
        },
        name: state.name,
        driveKey: "",
        discoveryKey: hex(ownDrive.discoveryKey),
        peers: swarm.connections.size,
        photos: 0,
        members: [],
      };
    }
    const registry = await readRegistryIn(rt.folderDrive);
    const selfKey = rt.record.role === "creator" ? hex(rt.folderDrive.key) : hex(ownDrive.key);
    // Every role reports a self-consistent member set: the local device first,
    // then the enrolled members from the registry. Dedupe self in case the
    // registry already lists this device (issue #89) — a member/reader's own key
    // may appear in `registry.members`, but must not be double-counted.
    const memberList: SyncMember[] = [
      { key: selfKey, name: state.name },
      ...Object.values(registry.members)
        .filter((m) => m.key !== selfKey)
        .map((m) => ({ key: m.key, name: m.name })),
    ];
    const photos = (await listPhotosIn(rt)).length;
    const role = rt.record.role;
    return {
      folder: toSummary(rt),
      name: state.name,
      driveKey: role === "creator" ? selfKey : role === "member" ? selfKey : "",
      discoveryKey: hex(ownDrive.discoveryKey),
      peers: swarm.connections.size,
      photos,
      members: memberList,
    };
  }

  /** Announce this device's own drive on a folder's topic as a SERVER: peers on
   * that topic (the folder's creator) become able to resolve this device's
   * drive and read `/requests.json` from it. */
  async function announceOwnDriveOnTopic(discoveryKey: Buffer, label: string) {
    try {
      await joinTopic(discoveryKey, { server: true });
    } catch (e) {
      const message = errMsg(e);
      console.error(`[justus] failed to announce drive on ${label} topic: ${message}`);
    }
  }

  /**
   * Read pending join-request outboxes off requester drives announced on a
   * creator folder's topic.
   *
   * Join-request transport (dev/e2e-testable; see below):
   *  - A requester that can't enroll writes `/requests.json` (keyed by the
   *    target share key) onto its OWN single-writer drive, then announces that
   *    drive on the target folder's topic as a server (`{ server: true }`).
   *  - This device (the folder's creator), serving the same topic, sees the
   *    requester's connection and records its `remotePublicKey`. `requests()`
   *    takes those recorded peer keys, opens each as a drive read-only and
   *    reads `/requests.json`, keeping the entries whose share key matches.
   *
   * Honesty about ekrooh#41: the on-device (Android bare-kit) worklet cannot
   * open a peer's drive (`timeout opening remote drive`), so the CREATOR-side
   * read here only works when the creator can open the requester's drive —
   * true in the LOCAL-DHT multi-worklet desktop stack (bare↔node and
   * desktop↔desktop replication work), but blocked on-device until #41 is
   * fixed. requester→creator: one device CANNOT reach a folder it doesn't
   * know, and a peer's drive can only be read if the requester's announced
   * drive key resolves (here: the connection's `remotePublicKey`). Where the
   * swarm peer identity differs from the announced drive key this read misses
   * the request — a known platform limitation, see ekrooh#41.
   */
  async function readRequestsFromPeers(rt: FolderRuntime): Promise<JoinRequest[]> {
    const shareKey = rt.record.shareKey;
    // Open every peer's request outbox concurrently. A peer whose drive never
    // becomes ready (unreachable) is bounded by `openDriveWithTopic`'s timeout
    // *per drive* — running the opens in parallel keeps total latency at ~one
    // timeout rather than N timeouts summed across unreachable peers (issue #88).
    const tasks = [...rt.social.peers]
      .filter(isHexKey)
      .map(async (peerKeyHex): Promise<JoinRequest[]> => {
        let peerDrive: Drive;
        try {
          peerDrive = await openDriveWithTopic(peerKeyHex, { server: false });
        } catch (e) {
          console.error(
            `[justus] cannot open requester drive ${peerKeyHex.slice(0, 12)}: ${errMsg(e)}`,
          );
          return [];
        }
        const text = await getText(peerDrive, DRIVE_PATH_REQUESTS);
        if (text === null) return [];
        let parsed: RequestsFile;
        try {
          const raw = JSON.parse(text) as { version?: unknown; requests?: unknown };
          if (raw.version !== 1 || !isTextJSON(raw.requests)) return [];
          parsed = { version: 1, requests: raw.requests as RequestsFile["requests"] };
        } catch {
          return [];
        }
        const out: JoinRequest[] = [];
        for (const req of Object.values(parsed.requests)) {
          if (req.shareKey !== shareKey) continue;
          out.push({
            requesterKey: req.requesterKey,
            requesterName: req.requesterName || "Unknown device",
            folderId: rt.record.id,
            folderName: req.folderName || rt.record.name,
            shareKey,
            requestedAt: req.requestedAt,
          });
        }
        return out;
      });
    const settled = await Promise.allSettled(tasks);
    return settled.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  }

  async function setup(): Promise<void> {
    await corestore.ready();
    ownDrive = deps.makeDrive(corestore);
    await ownDrive.ready();
    await ensureOwnDriveIdentity();

    // Swarm: seed our own identity drive; replicate everything over each conn.
    // Registered before any topic join so early connections replicate too.
    swarm.on("connection", (conn: any) => {
      conn.on("error", () => {});
      try {
        corestore.replicate(conn);
      } catch (e) {
        const message = errMsg(e);
        console.error(`[justus] replicate failed: ${message}`);
      }
      const peerKey = conn.remotePublicKey;
      if (peerKey && Buffer.isBuffer(peerKey)) {
        const peerHex = hex(peerKey);
        // Record the peer against every folder whose topic we serve — the
        // request transport reads these peers' `/requests.json` outboxes.
        for (const rt of runtimes.values()) {
          if (rt.record.role === "creator") rt.social.peers.add(peerHex);
        }
      }
    });
    await joinTopic(ownDrive.discoveryKey);

    const ownKey = hex(ownDrive.key);

    // Reopen every persisted folder so their drives stay warm. A folder whose
    // share key equals our own drive is our own creator folder (the device's
    // identity drive — the first folder). Others are remote join targets.
    for (const record of state.folders) {
      const isOwn = record.shareKey === ownKey;
      const fd = isOwn ? ownDrive : await openDriveWithTopic(record.shareKey, { server: false });
      const registry = await readRegistryIn(fd);
      const enrolled = Object.values(registry.members).some((m) => m.key === ownKey);
      // A folder this device created is persisted with role "creator"; after a
      // restart the identity-drive shortcut (`isOwn`) only fires for the single
      // identity drive, so a 2nd+ creator folder would otherwise be recomputed
      // from the live registry (which doesn't list the creator as a member) and
      // downgrade to "reader" (issue #42). Trust the persisted creator role so
      // every creator folder re-opens as a creator.
      const role: Role =
        record.role === "creator" ? "creator" : isOwn ? "creator" : enrolled ? "member" : "reader";
      // A folder whose request was approved since we last ran is now a member —
      // clear the pending badge. Pending only applies to requested, un-enrolled
      // (reader) folders like the one created at join() time.
      const pending =
        record.role === "creator" ? false : enrolled ? false : Boolean(record.pending);
      const rt: FolderRuntime = {
        record: {
          ...record,
          role,
          driveKey: record.role === "creator" ? hex(fd.key) : enrolled ? ownKey : "",
          pending,
        },
        folderDrive: fd,
        selfDrive: role === "reader" ? null : ownDrive,
        memberDrives: new Map(),
        memberNameCache: new Map(),
        mounted: new Set(),
        watcherRemoves: new Set(),
        social: { peers: new Set() },
      };
      runtimes.set(record.id, rt);
      await refreshMembersFor(rt);
      watchDrive(fd, record.id, hex(fd.key), record.role === "creator" ? "enroll" : "add");
      if (isOwn) watchDrive(ownDrive, record.id, ownKey, "enroll");
    }

    // No folders yet (fresh install) → create the device's first creator folder
    // from its identity drive, mirroring the previous single-folder behaviour.
    if (state.folders.length === 0) {
      const folderId = newId(deps.crypto);
      const folderDrive = ownDrive;
      const rt: FolderRuntime = {
        record: {
          id: folderId,
          name: "My Photos",
          role: "creator",
          shareKey: ownKey,
          driveKey: ownKey,
          createdAt: Date.now(),
        },
        folderDrive,
        selfDrive: ownDrive,
        memberDrives: new Map(),
        memberNameCache: new Map(),
        mounted: new Set(),
        watcherRemoves: new Set(),
        social: { peers: new Set() },
      };
      runtimes.set(folderId, rt);
      state.folders.push(rt.record);
      state.activeFolderId = folderId;
      saveState();
      await folderDrive.put(
        DRIVE_PATH_FOLDER,
        Buffer.from(JSON.stringify({ version: 1, name: rt.record.name })),
      );
      await refreshMembersFor(rt);
      watchDrive(ownDrive, folderId, ownKey, "enroll");
      if (deps.seedOnEmpty) await seedSamplePhotos(ownDrive);
    } else if (state.activeFolderId === null) {
      // Restore an active pointer if the persisted one didn't survive.
      const ownFolder = state.folders.find((f) => f.shareKey === ownKey) ?? state.folders[0];
      state.activeFolderId = ownFolder.id;
      saveState();
    }
  }

  return {
    async ready() {
      if (readyPromise) return readyPromise;
      // A transient `setup()` failure (e.g. a flaky corestore/swarm) must not
      // permanently poison the store: clear the memoized promise on rejection so
      // the next `ready()` re-runs setup instead of re-throwing the same stale
      // error forever (issue #98).
      readyPromise = setup().catch((e) => {
        readyPromise = null;
        throw e;
      });
      return readyPromise;
    },

    async list() {
      await readyPromise;
      const rt = activeRuntime();
      return rt ? listPhotosIn(rt) : [];
    },

    async add(filePath, name) {
      await readyPromise;
      // Thread the picker's original display name through (#99); without it the
      // stored photo would be named after the host's temp staging file rather
      // than the user's file. `addFromPath` falls back to the basename when
      // `name` is absent, so the old behaviour is preserved for nameless adds.
      return addFromPath(filePath, name);
    },

    /** Adds a photo from bytes uploaded in-band (browser multi-file picker):
     * stages the bytes to a temp file so the path-based flow stays the single
     * source of truth, then imports it. */
    async addBytes(name, bytes) {
      await readyPromise;
      const rt = activeRuntime();
      if (!rt) return err(PhotoError.NO_ACTIVE_FOLDER, "No folder is active");
      if (rt.record.role === "reader") {
        return err(PhotoError.NOT_A_MEMBER, "Readers cannot add photos");
      }
      const safeName =
        typeof name === "string" && name.trim() ? name.trim() : `photo-${newId(deps.crypto)}`;
      const ext = path.extname(safeName).toLowerCase().replace(/^\.$/, "");
      const staged = path.join(deps.cacheDir, `upload-${newId(deps.crypto)}${ext}`);
      try {
        fs.writeFileSync(staged, bytes as Buffer);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return err(ErrorCode.HOST_ERROR, `Failed to stage upload: ${message}`);
      }
      try {
        // Thread the real upload filename through (#82); the staged temp file is
        // named `upload-<id>`, so without this the stored photo would be named
        // after the temp file rather than the user's file.
        return await addFromPath(staged, safeName);
      } finally {
        try {
          fs.unlinkSync(staged);
        } catch {
          // already gone — nothing to clean up
        }
      }
    },

    async remove(id) {
      await readyPromise;
      const rt = activeRuntime();
      if (!rt) return err(PhotoError.NO_ACTIVE_FOLDER, "No folder is active");
      const role = rt.record.role;
      const selfKey = role === "creator" ? hex(rt.folderDrive.key) : hex(ownDrive.key);
      const selfDrive = role === "creator" ? rt.folderDrive : ownDrive;
      // Own photo → delete from own drive.
      for (const base of await drivePhotoKeys(selfDrive)) {
        if (base.startsWith(`${id}.`) || base === id) {
          await selfDrive.del(`${DRIVE_PATH_PHOTOS}/${base}`);
          pruneIndex(id, selfKey);
          deps.onChanged({ cause: "remove", folderId: rt.record.id, memberKey: selfKey });
          return ok({ id });
        }
      }
      // Creator → tombstone another member's photo out of the derived view.
      if (role === "creator") {
        let removed = await readRemovedIn(rt.folderDrive);
        let tombstoned = false;
        for (const [key, drive] of rt.memberDrives) {
          for (const base of await drivePhotoKeys(drive)) {
            if (base.startsWith(`${id}.`) || base === id) {
              removed[`${key}:${id}`] = { memberKey: key, removedAt: Date.now() };
              pruneIndex(id, key);
              tombstoned = true;
            }
          }
        }
        if (tombstoned) {
          await rt.folderDrive.put(
            DRIVE_PATH_REMOVED,
            Buffer.from(JSON.stringify({ version: 1, removed })),
          );
          deps.onChanged({ cause: "remove", folderId: rt.record.id });
          return ok({ id });
        }
      }
      return err(PhotoError.NOT_FOUND, `No photo ${id}`);
    },

    async join(key) {
      await readyPromise;
      if (!isHexKey(key)) return err(PhotoError.INVALID_KEY, "Share key must be a 64-char hex key");
      if (key === hex(ownDrive.key))
        return err(PhotoError.INVALID_KEY, "You already own this folder");

      // Idempotency (issue #47): re-joining a folder we already hold must not
      // mint a second `FolderRecord` with a fresh id — that leaves two folders
      // pointing at the same share key and double-counts it in `folders()`.
      // Reuse the existing record/runtime instead.
      const existing = state.folders.find((f) => f.shareKey === key);
      if (existing) {
        let rt = runtimes.get(existing.id);
        if (!rt) {
          // Runtime was dropped (e.g. after a restart re-setup): rebuild it from
          // the persisted record so the device's own view stays consistent.
          try {
            const fd = await openDriveWithTopic(key, { server: false });
            const registryForRole = await readRegistryIn(fd);
            const ownKey = hex(ownDrive.key);
            const enrolled = Object.values(registryForRole.members).some((m) => m.key === ownKey);
            const role: Role =
              existing.role === "creator" ? "creator" : enrolled ? "member" : "reader";
            rt = {
              record: {
                ...existing,
                role,
                driveKey: role === "reader" ? "" : ownKey,
                pending: role === "reader" ? Boolean(existing.pending) : false,
              },
              folderDrive: fd,
              selfDrive: role === "reader" ? null : ownDrive,
              memberDrives: new Map(),
              memberNameCache: new Map(),
              mounted: new Set(),
              watcherRemoves: new Set(),
              social: { peers: new Set() },
            };
            runtimes.set(existing.id, rt);
            await refreshMembersFor(rt);
            watchDrive(fd, rt.record.id, hex(fd.key), "add");
          } catch {
            return ok(await computeStatus());
          }
        }
        return ok(await computeStatus());
      }

      let drive: Drive;
      let registry: RegistryFile;
      let folderName = "";
      try {
        // Join the folder topic first so a peer serves the drive's blocks
        // (a remote `drive.ready()` otherwise waits forever).
        drive = await openDriveWithTopic(key, { server: false });
        // The registry tells us whether this device is enrolled as a member.
        registry = await readRegistryIn(drive);
        folderName = await readFolderNameIn(drive);
      } catch (e) {
        const message = errMsg(e);
        return err(PhotoError.INVALID_KEY, `Cannot open folder: ${message}`);
      }

      const ownKey = hex(ownDrive.key);
      const enrolled = Object.values(registry.members).some((m) => m.key === ownKey);
      const role: Role = enrolled ? "member" : "reader";
      const folderId = newId(deps.crypto);

      const rt: FolderRuntime = {
        record: {
          id: folderId,
          name: folderName || "Joined folder",
          role,
          shareKey: key,
          driveKey: enrolled ? ownKey : "",
          createdAt: Date.now(),
        },
        folderDrive: drive,
        selfDrive: role === "reader" ? null : ownDrive,
        memberDrives: new Map(),
        memberNameCache: new Map(),
        mounted: new Set(),
        watcherRemoves: new Set(),
        social: { peers: new Set() },
      };
      runtimes.set(folderId, rt);

      if (!enrolled) {
        // Not yet a member → file a JOIN REQUEST on this device's own drive
        // (single-writer — always writable) and announce that drive on the
        // folder's topic so its creator (`requests()`) can read it.
        // The request outbox is keyed by share key.
        rt.record.pending = true;
        let requests: RequestsFile = { version: 1, requests: {} };
        const existingText = await getText(ownDrive, DRIVE_PATH_REQUESTS);
        if (existingText) {
          try {
            const raw = JSON.parse(existingText) as { version?: unknown; requests?: unknown };
            if (raw.version === 1 && isTextJSON(raw.requests)) {
              requests = { version: 1, requests: raw.requests as RequestsFile["requests"] };
            }
          } catch {
            // start fresh
          }
        }
        requests.requests[key] = {
          requesterKey: ownKey,
          requesterName: state.name,
          shareKey: key,
          folderName: folderName,
          requestedAt: Date.now(),
        };
        await ownDrive.put(DRIVE_PATH_REQUESTS, Buffer.from(JSON.stringify(requests)));
        await announceOwnDriveOnTopic(drive.discoveryKey, "folder");

        // This device becomes a (read-only) reader of the requested folder —
        // the gallery shows it as pending until the creator approves.
        rt.social.peers.clear(); // readers don't read others' request outboxes
        state.folders.push(rt.record);
        state.activeFolderId = folderId;
        saveState();
        await refreshMembersFor(rt);
        // Watch the folder (creator) drive so replication updates — including
        // the creator's approval that flips this device reader → member — reach
        // this store in-session (issue #52).
        watchDrive(drive, folderId, hex(drive.key), "add");
        deps.onChanged({ cause: "request", folderId });
        return ok(await computeStatus());
      }

      // Already enrolled → member; make it active.
      rt.social.peers.clear();
      state.folders.push(rt.record);
      state.activeFolderId = folderId;
      saveState();
      await refreshMembersFor(rt);
      watchDrive(drive, folderId, hex(drive.key), "add");
      deps.onChanged({ cause: "enroll", folderId });
      return ok(await computeStatus());
    },

    async enroll(key, name) {
      await readyPromise;
      const rt = activeRuntime();
      if (!rt) return err(PhotoError.NO_ACTIVE_FOLDER, "No folder is active");
      if (rt.record.role !== "creator")
        return err(PhotoError.NOT_CREATOR, "Only the creator can enroll members");
      if (!isHexKey(key)) return err(PhotoError.INVALID_KEY, "Drive key must be a 64-char hex key");
      if (key === hex(rt.folderDrive.key))
        return err(PhotoError.INVALID_KEY, "You cannot enroll yourself");
      const registry = await readRegistryIn(rt.folderDrive);
      if (registry.members[key]) {
        return err(PhotoError.ALREADY_ENROLLED, "Member already enrolled");
      }
      registry.members[key] = { key, name, addedAt: Date.now() };
      await rt.folderDrive.put(DRIVE_PATH_MEMBERS, Buffer.from(JSON.stringify(registry)));
      await loadMemberDrive(rt, key, name);
      deps.onChanged({ cause: "enroll", folderId: rt.record.id, memberKey: key });
      return ok(await computeStatus());
    },

    async status() {
      await readyPromise;
      return computeStatus();
    },

    async folders() {
      await readyPromise;
      const folders: FolderSummary[] = [];
      for (const rt of runtimes.values()) {
        folders.push(toSummary(rt));
      }
      return { folders, activeFolderId: activeFolderId() ?? "" };
    },

    async createFolder(name) {
      await readyPromise;
      if (!name || typeof name !== "string" || !name.trim()) {
        return err(PhotoError.NAME_REQUIRED, "Folder name is required");
      }
      const cleanName = name.trim();
      // A new creator folder gets a NEW single-writer drive of its own.
      const newDrive = deps.makeDrive(corestore);
      await newDrive.ready();
      await newDrive.put(DRIVE_PATH_DEVICE, Buffer.from(JSON.stringify({ name: state.name })));
      await newDrive.put(
        DRIVE_PATH_FOLDER,
        Buffer.from(JSON.stringify({ version: 1, name: cleanName })),
      );

      const folderId = newId(deps.crypto);
      const rt: FolderRuntime = {
        record: {
          id: folderId,
          name: cleanName,
          role: "creator",
          shareKey: hex(newDrive.key),
          driveKey: hex(newDrive.key),
          createdAt: Date.now(),
        },
        folderDrive: newDrive,
        selfDrive: newDrive,
        memberDrives: new Map(),
        memberNameCache: new Map(),
        mounted: new Set(),
        watcherRemoves: new Set(),
        social: { peers: new Set() },
      };
      runtimes.set(folderId, rt);
      state.folders.push(rt.record);
      state.activeFolderId = folderId;
      saveState();
      await joinTopic(newDrive.discoveryKey, { server: true });
      watchDrive(newDrive, folderId, hex(newDrive.key), "enroll");
      if (deps.seedOnEmpty) await seedSamplePhotos(newDrive);
      deps.onChanged({ cause: "enroll", folderId });
      return ok({ folder: toSummary(rt) });
    },

    async setActive(folderId) {
      await readyPromise;
      const rt = runtimes.get(folderId);
      if (!rt) return err(PhotoError.FOLDER_NOT_FOUND, `No folder ${folderId}`);
      // Clean up the outgoing active folder's spool + loopback mounts so its
      // bytes never leak into the new active folder's gallery.
      const prev = activeRuntime();
      if (prev && prev !== rt) {
        await unmountRuntime(prev);
      }
      state.activeFolderId = folderId;
      saveState();
      // Issue #86/#91/#96: switching away from this folder ran `unmountRuntime`,
      // which closed + cleared `rt.memberDrives`. If we now re-activate it, those
      // member drives must be re-opened and their update watchers re-armed —
      // otherwise peer/owner live updates stop reaching the gallery after a
      // folder round-trip. Re-sync the enrolled member set from the registry
      // (idempotent when already loaded) before arming watchers.
      await refreshMembersFor(rt);
      armFolderWatchers(rt);
      deps.onChanged({ cause: "enroll", folderId });
      return ok(await computeStatus());
    },

    async setName(name) {
      await readyPromise;
      if (!name || typeof name !== "string" || !name.trim()) {
        return err(PhotoError.NAME_REQUIRED, "Name is required");
      }
      const cleanName = name.trim();
      state.name = cleanName;
      saveState();
      await ownDrive.put(DRIVE_PATH_DEVICE, Buffer.from(JSON.stringify({ name: cleanName })));
      // Update every creator drive's device.json + folder identity to match.
      for (const rt of runtimes.values()) {
        if (rt.record.role === "creator") {
          try {
            await rt.folderDrive.put(
              DRIVE_PATH_DEVICE,
              Buffer.from(JSON.stringify({ name: cleanName })),
            );
          } catch (e) {
            const message = errMsg(e);
            console.error(`[justus] failed to update creator device name: ${message}`);
          }
        }
      }
      deps.onChanged({ cause: "enroll", folderId: activeFolderId() ?? undefined });
      return ok({ name: cleanName });
    },

    async requests() {
      await readyPromise;
      const out: JoinRequest[] = [];
      for (const rt of runtimes.values()) {
        if (rt.record.role !== "creator") continue;
        // A requester already enrolled as a member is no longer pending — its
        // request lives on only in its own outbox, so drop it (#84).
        let enrolled: Set<string> | null = null;
        try {
          const registry = await readRegistryIn(rt.folderDrive);
          enrolled = new Set(Object.values(registry.members).map((m) => m.key));
        } catch {
          enrolled = new Set();
        }
        const found = await readRequestsFromPeers(rt);
        for (const req of found) {
          if (enrolled.has(req.requesterKey)) continue;
          if (deniedRequesters.has(req.requesterKey)) continue;
          out.push(req);
        }
      }
      return { requests: out };
    },

    async respond(folderId, requesterKey, approve) {
      await readyPromise;
      const rt = runtimes.get(folderId);
      if (!rt) return err(PhotoError.FOLDER_NOT_FOUND, `No folder ${folderId}`);
      if (rt.record.role !== "creator")
        return err(PhotoError.NOT_CREATOR, "Only the creator can respond to requests");
      if (!isHexKey(requesterKey))
        return err(PhotoError.INVALID_KEY, "Requester key must be a 64-char hex key");
      const registry = await readRegistryIn(rt.folderDrive);
      const alreadyPresent = Boolean(registry.members[requesterKey]);
      if (!approve) {
        // Denials have no state to write — the request just stays on the
        // requester's own drive until it is superseded. Remember it for the
        // session so a re-filed request doesn't resurface as pending (#85).
        deniedRequesters.add(requesterKey);
        deps.onChanged({ cause: "request", folderId });
        return ok({ ok: true });
      }
      if (alreadyPresent) {
        return err(PhotoError.ALREADY_ENROLLED, "Member already enrolled");
      }
      // Prefer the requester's own reported name from its `/requests.json`;
      // fall back to a neutral label when we can't resolve the outbox.
      let requesterName = "New member";
      for (const req of await readRequestsFromPeers(rt)) {
        if (req.requesterKey === requesterKey) {
          requesterName = req.requesterName;
          break;
        }
      }
      registry.members[requesterKey] = {
        key: requesterKey,
        name: requesterName,
        addedAt: Date.now(),
      };
      await rt.folderDrive.put(DRIVE_PATH_MEMBERS, Buffer.from(JSON.stringify(registry)));
      await loadMemberDrive(rt, requesterKey, requesterName);
      deps.onChanged({ cause: "enroll", folderId, memberKey: requesterKey });
      return ok({ ok: true });
    },

    async close() {
      // Tear down every folder: drop update watchers, unmount loopback routes,
      // and remove the per-folder spool dir so a shutdown leaves no mounts or
      // stale cache behind (#101).
      for (const rt of runtimes.values()) {
        await unmountRuntime(rt);
      }
      // Defensively release any remaining joins (e.g. the device-identity
      // `ownDrive` join that `unmountRuntime` never leaves) before tearing down
      // the swarm (issue #95).
      for (const key of joins.keys()) leaveTopic(key);
      try {
        await swarm.destroy();
      } catch {
        // already closed
      }
      try {
        await corestore.close();
      } catch {
        // already closed
      }
    },
  };
}

// Seed data: real generated JPEGs (480x320 gradients), dev only.
const SAMPLE_1 = base64ToBytes(
  "/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAB4KADAAQAAAABAAABQAAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgBQAHgAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwUDAwMFBgUFBQUGCAYGBgYGCAoICAgICAgKCgoKCgoKCgwMDAwMDA4ODg4ODw8PDw8PDw8PD//bAEMBAgICBAQEBwQEBxALCQsQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEP/dAAQAHv/aAAwDAQACEQMRAD8A+IAlShO9TBPapAlfzNKkfxxSqkQTFSiPtUwSpAlYypHoUqpEEqUJ3qYJUqp7VjKkelSqkQTtUgTtUwSpQntWUqR6FKqRBO9ShKlCVKErGVI9KlVIhH2qUR1KEqUJWMqR6FKqRBO9ShKlVB6VKqVi6R6VKqRBO1SiPNTBPapQlYypHoUqpCE71KqVMEqVUrJ0j0qVUiEdSBKmCVKEHpWMqR6FKqRKlSCOplSpQntWMqR6VKqRBM1KEqYJUgTnpWTpHoUqpEEqUJ2qVUqUJWLpHpUqpEEqUJ3xUwSpVSsZUj0KVUhCVKE7VMqe1ShKxlSPSpVSIJUgSpgntUqpWMqR6FKqRBO1SLHUwT2qUJWUqR6VKqRBO+KlCVKEqVU7YrGVI9ClVIlj7VKEqYJUgT2rGVI9KlVIgnepRHiplSpAlZSpHoUqpEsdShKmCVKErF0j0qVUhCVKI6mVO2KlCVjKkehSqkSpUgSpgntUoSsnSPSpVSIR4qUJ2qUJUoSsZUj0KVUiCVKE71ME9qkCVjKkelSqkQTFSiPtUwSpAlYypHoUqpEEqUJ3qYJUqp7VjKkelSqkQTtUgTtUwSpQntWTpHoUqpEE71KEqUJUoSsXSPSpVSIR9qlEdShKlCVjKkehSqn/0PjZUqQJUwSpVSv52dI/iilVIglShKmCe1SBO1ZSpHo0qpEqVKEqYJUoTvWLpHo0qpCEqUJUwSpQnasZUj0aVUhCVKEqYJUoTvWUqR6NKqRBKkVKmCdqlCVjKkejSqkQSpAlThO9SBKxlSPRpVSIJUoSpgnapQlYukejSqkKpUoSpgnepQlYypHo0qpCEqUJUwSpQlZOkejSqkISpQlTBKlVKxlSPRpVSEJUqpUwTNShKylSPRpVSIJUgSp1SpFTtWEqR6NKqRBKlCVMEqQJ3xWUqR6NKqRBKlCVMEqUJ2rF0j0aVUhVKlCVMEqUJ3rKVI9GlVIQlShKm",
);
const SAMPLE_2 = base64ToBytes(
  "/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAB4KADAAQAAAABAAABQAAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgBQAHgAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwUDAwMFBgUFBQUGCAYGBgYGCAoICAgICAgKCgoKCgoKCgwMDAwMDA4ODg4ODw8PDw8PDw8PD//bAEMBAgICBAQEBwQEBxALCQsQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEP/dAAQAHv/aAAwDAQACEQMRAD8A+MwtPC1KFp4Wv9DXWPkoTIgtPC/hUoWnhfwrN1jqhMiC08LUoWnhaj2x1QmRBaeF/CpQtPC/hWbrHVCZEFp4X8alC08LUOsdUJkQWnhfwqULTwv4VDrHVCZEFp4X8alC08L+NQ6x1QmRBaeF/CpQtPC/hWbrHVCZEFp4X8alC08L+NR7Y6oTIgtPC/hUoWnhfwrN1jqhMiC08L+NShaeF/GodY6oTIgtPC/hUoWnhfwqHWOqEyILTwv41KFp4X8ah1jqhMiC08L+FShaeF/Cs3WOqEyILTwv41KFp4X8aj2x1QmRBaeF/CpQtPC/hWbrHVCZEFp4X8alC08L+NQ6x1QmRBaeF/CpQtPC/hWbrHVCZEFp4WpQtPC1DrHVCZEFp4X8KlC08L+FQ6x1QmRBaeFqULTwtZusdUJkQWnhfwqULTwv4VHtjqhMiC08LUoWnhazdY6oTIgtPC/hUoWnhfwqHWOqEyILTwtShaeFqHWOqEyILTwv4VKFp4X8Kh1jqhMiC+1PC1KFp4Ws3WOqEyILTwv4VKFp4X8Kj2x1QmRBfanbamC+1PC1m6x1QmRBaeF/CpQtPC/hUOsdUJn/0PkILTwtShaeFr+93WPh4TIgtPC1KFp4WodY6oTIgtPC1KFp4WodY6oTIgtPC1KFp4Ws3WOqEyILTwtShaeFqHWOqEyILTwtShaeFrN1jqhMiC08LUoWnhah1jqhMiC08LUoWnhazdY6oTIgtPC1KFp4WodY6oTIgtPC1KFp4WodY6oTIgtPC1KFp4WodY6oTIgpxTwtShaeFrN1jqhMiC08LUoWnhah1jqhMiCnFPC1KFp4Ws3WOqEyILTwtShaeFqHWOqEyIKcU8LUoWnhah1jqhMi208LUoWnhah1jqhMiCnFPC1KFp4Ws3WOqEyILbTwtShaeFqHWOqEyIKcU8LUoWnhazdY6oTIttPC+tShaeFrN1jqhMiCnFPC1K",
);
const SAMPLE_3 = base64ToBytes(
  "/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAB4KADAAQAAAABAAABQAAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgBQAHgAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwUDAwMFBgUFBQUGCAYGBgYGCAoICAgICAgKCgoKCgoKCgwMDAwMDA4ODg4ODw8PDw8PDw8PD//bAEMBAgICBAQEBwQEBxALCQsQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEP/dAAQAHv/aAAwDAQACEQMRAD8A9BzipAcVCOlSA5r450z+mJTJQe9PBzUYNSDpWbpmUpk2cU8HvUK1ID2rJ0zFzJQc1NnFQA+tSLWbpmUpkwPeng5qIHtUg6Vm6ZjKZNUgqFakB7Vk6ZjKZKDmpAc1EOlSLWbpmUpkwp4OahHWpAcVk6Zk5kwOalFQg+tPB5rN0zFzJgc1IDmoQcVKtZOmYymTDpT16VCDzUgOKzdMycyYHNSA9qiWng81k6ZjKoTL0qQHNQZ9KlBxWbpmUpEwPapF6VCKfn0rN0zGVQnBzUgPaoQcVIKydMxlMlBxUi1Dn0qSs3TMZTJgecVIDioQe9SA1k6ZlKZMtSA84qHPpUgPes3TMnMmBxUi1ADmpc+lZOmYymSjrUmcVED3p4OazdMxlMmBxUi9aiz6VIKydMycyXOKkBxUI6VIDWbpmMpky9akzioQakHSs3TMnMmBxUi9ahBzUgNZOmYuZLUucVCOlSA5rN0zKUyUHvTwc1GDTwfWsnTMZSJ84p4PeoVqQHtWbpmMqhKDmps4qAH1qRaydMylImB708HNRA9qkHSs3TMXMlBzUoqFaeOtZOmYymf/0O9zipAcVCOlSA1846Z/RrmTL1qTOKhBqQdKydMxlMmBxUi9ahBzUgNZumZSmS1LnFQjpT1rJ0zGUyYHvTwc1ED2qQH1rN0zGUyfOKeD3qFakB7Vk6Zk5koOamzioB0qRazdMxlMmB708HNRA9qkHSs3TMnMlBzUoqFaeOtZOmYuZMDmpAc1CDipQfWs3TMpTJhTwc1CDzUgOKydMxlImBzUo6VCtPB5rN0zFzJl6VIDmoQcVKtZOmZSmSg9qkXpUIPNPz6Vm6Zk5k4OakB7VCDipAaydMwlMmXpUgOagz6VKDis3TMnMmB7VIvSoRT8+lZumYymTLUgPOKhqQHvWTpmUpkwOKkWoQakz6Vm6ZjKZMDzipAcVCD3p4OaydMylMnWpAecVDn0qQHvW",
);
