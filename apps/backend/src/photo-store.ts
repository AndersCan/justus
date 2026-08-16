import fs from "bare-fs";
import path from "bare-path";
import crypto from "bare-crypto";
import Corestore from "corestore";
import Hyperdrive from "hyperdrive";
import Hyperswarm from "hyperswarm";
import { type LoopbackServer } from "@ekrooh/bare/runtime";
import { CoreError, ErrorCode, err, ok } from "@ekrooh/bare/core";
import type { Photo, PhotoChanged, SyncMember, SyncStatus } from "@justus/core";

/** Canonical app-scoped error codes (preserved verbatim on the wire). */
export const PhotoError = {
  NOT_A_MEMBER: "justus.photos/not-a-member",
  NOT_CREATOR: "justus.photos/not-creator",
  ALREADY_ENROLLED: "justus.photos/already-enrolled",
  NOT_FOUND: "justus.photos/not-found",
  INVALID_KEY: "justus.photos/invalid-key",
} as const;

export type FolderRole = "creator" | "member" | "reader";

/** Any drive handle (the p2p packages ship no types). */
type Drive = any;

/** Success/failure tuple matching the framework's `Either<E, A>` union. */
type EitherResult<T> = [CoreError, null] | [null, T];

type PersistedState = {
  name: string;
  folder: { role: FolderRole; shareKey: string } | null;
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
};

export type PhotoStoreDeps = {
  storageDir: string;
  cacheDir: string;
  server: LoopbackServer;
  /** This device's display name (persisted; defaults generated). */
  deviceName: string;
  /** Push a backend → web `photos.changed` dispatch. */
  onChanged: (change: PhotoChanged) => void;
  /** Seed sample photos on an empty drive (dev only). */
  seedOnEmpty: boolean;
  /** Hyperswarm DHT bootstrap servers (dev/test: local DHT node). */
  bootstrap?: string[];
};

export interface PhotoStore {
  ready(): Promise<void>;
  list(): Promise<Photo[]>;
  add(path: string): Promise<EitherResult<Photo>>;
  /** Adds a photo from in-band bytes (browser multi-file picker). */
  addBytes(name: string, bytes: Uint8Array): Promise<EitherResult<Photo>>;
  remove(id: string): Promise<EitherResult<{ id: string }>>;
  join(key: string): Promise<EitherResult<SyncStatus>>;
  enroll(key: string, name: string): Promise<EitherResult<SyncStatus>>;
  status(): Promise<SyncStatus>;
  close(): Promise<void>;
}

const DRIVE_PATH_PHOTOS = "/photos";
const DRIVE_PATH_DEVICE = "/device.json";
const DRIVE_PATH_MEMBERS = "/members.json";
const DRIVE_PATH_REMOVED = "/removed.json";
const STATE_FILE = "justus.json";

function newId(): string {
  return `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
}

function hex(buffer: Buffer): string {
  return buffer.toString("hex");
}

function isHexKey(key: string): boolean {
  return /^[0-9a-f]{64}$/i.test(key);
}

function isTextJSON(value: unknown): value is { [k: string]: unknown } {
  return typeof value === "object" && value !== null;
}

/** Pumps a source stream into a file, resolving on completion. */
function pumpToFile(source: NodeJS.ReadableStream, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(destPath);
    source.on("data", (chunk: unknown) => out.write(chunk as never));
    source.on("end", () => out.end(() => resolve()));
    source.on("error", (e) => {
      try {
        out.destroy();
      } catch {
        // already closed
      }
      reject(e);
    });
    out.on("error", reject);
  });
}

export function createPhotoStore(deps: PhotoStoreDeps): PhotoStore {
  const corestore = new Corestore(path.join(deps.storageDir, "corestore"));
  const swarm = new Hyperswarm(deps.bootstrap ? { bootstrap: deps.bootstrap } : undefined);
  const stateFile = path.join(deps.storageDir, STATE_FILE);
  const spoolDir = path.join(deps.cacheDir, "photos");

  let state: PersistedState = { name: deps.deviceName, folder: null };
  let ownDrive: Drive;
  let folderDrive: Drive = null as unknown as Drive;
  let role: FolderRole = "creator";
  let members: SyncMember[] = [];
  const memberDrives = new Map<string, Drive>();
  const memberNameCache = new Map<string, string>();
  const mounted = new Set<string>();
  const joins: Array<{ destroy(): void | Promise<void> }> = [];
  const watchers = new Set<() => void>();
  let readyPromise: Promise<void> | null = null;

  function loadState(): PersistedState {
    try {
      const raw = fs.readFileSync(stateFile, "utf8");
      const parsed = JSON.parse(raw);
      if (isTextJSON(parsed)) {
        const name = typeof parsed.name === "string" ? parsed.name : deps.deviceName;
        const folderRaw = parsed.folder as unknown;
        const folder =
          folderRaw !== null &&
          isTextJSON(folderRaw) &&
          typeof folderRaw.role === "string" &&
          typeof folderRaw.shareKey === "string"
            ? { role: folderRaw.role as FolderRole, shareKey: folderRaw.shareKey }
            : null;
        return { name, folder };
      }
    } catch {
      // Fresh state.
    }
    return { name: deps.deviceName, folder: null };
  }

  function saveState() {
    try {
      fs.writeFileSync(stateFile, JSON.stringify(state));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
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

  async function readDeviceName(drive: Drive, keyHex: string): Promise<string> {
    const cached = memberNameCache.get(keyHex);
    if (cached) return cached;
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
    memberNameCache.set(keyHex, name);
    return name;
  }

  async function ensureOwnDriveIdentity() {
    const text = await getText(ownDrive, DRIVE_PATH_DEVICE);
    if (text === null) {
      await ownDrive.put(DRIVE_PATH_DEVICE, Buffer.from(JSON.stringify({ name: state.name })));
    }
  }

  async function readRegistry(): Promise<RegistryFile> {
    const text = await getText(folderDrive, DRIVE_PATH_MEMBERS);
    if (text === null) {
      return { version: 1, members: {} };
    }
    try {
      const parsed = JSON.parse(text) as { version?: unknown; members?: unknown };
      if (parsed.version === 1 && isTextJSON(parsed.members)) {
        return { version: 1, members: parsed.members as RegistryFile["members"] };
      }
    } catch {
      // malformed — start empty
    }
    return { version: 1, members: {} };
  }

  async function readRemoved(): Promise<RemovedFile["removed"]> {
    if (role !== "creator") return {};
    const text = await getText(folderDrive, DRIVE_PATH_REMOVED);
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

  function watchDrive(drive: Drive, label: string) {
    const handler = debounce(() => {
      // Drive metadata changed locally or via replication — the gallery is
      // derived, so a refresh always suffices.
      scheduleChanged({ cause: "add", memberKey: label });
    }, 400);
    drive.on("update", handler);
    const remove = () => drive.removeListener("update", handler);
    watchers.add(remove);
  }

  function debounce(fn: () => void, ms: number): () => void {
    let timer: ReturnType<typeof setTimeout> | null = null;
    return () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(fn, ms);
    };
  }

  function scheduleChanged(change: PhotoChanged) {
    deps.onChanged(change);
  }

  async function joinTopic(topic: Buffer, opts?: { server?: boolean }) {
    const handle = swarm.join(topic, opts);
    joins.push(handle);
    // Fire-and-forget: never block setup on DHT bootstrap — the app must
    // boot and serve the gallery even when the swarm is unreachable.
    void handle.flushed?.().catch(() => {});
  }

  /** Opens a drive by key, joining its swarm topic first so peers serve its
   * blocks (a remote `drive.ready()` otherwise waits forever). */
  async function openDriveWithTopic(keyHex: string, opts?: { server?: boolean }): Promise<Drive> {
    const drive = new Hyperdrive(corestore, Buffer.from(keyHex, "hex"));
    const topic = drive.discoveryKey;
    await joinTopic(topic, opts);
    await Promise.race([
      drive.ready(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("timeout opening remote drive")), 45_000),
      ),
    ]);
    return drive;
  }

  async function loadMemberDrive(keyHex: string, name?: string) {
    if (memberDrives.has(keyHex)) return;
    if (keyHex === hex(ownDrive.key)) return;
    try {
      const drive = await openDriveWithTopic(keyHex, { server: false });
      memberDrives.set(keyHex, drive);
      if (name) memberNameCache.set(keyHex, name);
      watchDrive(drive, keyHex);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`[justus] failed to open member drive ${keyHex.slice(0, 12)}: ${message}`);
    }
  }

  async function refreshMembers() {
    const registry = await readRegistry();
    const entries = Object.values(registry.members).map((m) => ({
      key: m.key,
      name: m.name,
    }));
    members = entries;
    for (const entry of entries) {
      await loadMemberDrive(entry.key, entry.name);
    }
  }

  async function switchFolder(shareKey: string, nextRole: FolderRole) {
    // Tear down the previous folder scope.
    for (const join of joins) {
      try {
        await join.destroy();
      } catch {
        // already destroyed
      }
    }
    joins.length = 0;
    for (const remove of watchers) remove();
    watchers.clear();
    memberDrives.clear();
    memberNameCache.clear();

    folderDrive = await openDriveWithTopic(shareKey, { server: false });
    role = nextRole;
    state.folder = { role, shareKey };
    saveState();
  }

  async function listPhotos(): Promise<Photo[]> {
    const removed = await readRemoved();
    const photos: Photo[] = [];
    const selfKey = hex(ownDrive.key);

    const drivesToScan: Array<{ key: string; drive: Drive }> = [];
    if (role === "creator" || role === "member") {
      drivesToScan.push({ key: selfKey, drive: ownDrive });
    }
    for (const [key, drive] of memberDrives) {
      drivesToScan.push({ key, drive });
    }

    for (const { key, drive } of drivesToScan) {
      let entries: Array<{ key: string; value: Record<string, unknown> }> = [];
      try {
        const list = drive.list(DRIVE_PATH_PHOTOS);
        for await (const entry of list) entries.push(entry as never);
      } catch {
        // Drive not downloaded yet — skip.
        continue;
      }
      for (const entry of entries) {
        const base = entry.key.slice(DRIVE_PATH_PHOTOS.length + 1);
        const extMatch = /^(.*?)(\.[^/.]+)?$/.exec(base);
        if (!extMatch) continue;
        const id = extMatch[1];
        const ext = extMatch[2] ?? "";
        const meta = (entry.value?.metadata ?? {}) as Partial<PhotoMeta>;
        const name = meta.name ?? base;
        const mime = meta.mime ?? guessMime(ext);
        const size = typeof entry.value?.size === "number" ? entry.value.size : 0;
        const addedAt = typeof meta.addedAt === "number" ? meta.addedAt : 0;
        if (removed[`${key}:${id}`]) continue;
        const memberName = key === selfKey ? state.name : await readDeviceName(drive, key);
        const mount = `/photos/${key.slice(0, 12)}-${id}`;
        const spoolPath = path.join(spoolDir, `${key.slice(0, 12)}-${id}${ext}`);
        try {
          await spoolToFile(drive, entry.key, spoolPath);
          if (!mounted.has(mount)) {
            deps.server.mount(mount, spoolPath);
            mounted.add(mount);
          }
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          console.error(`[justus] spool failed for ${base}: ${message}`);
          continue;
        }
        photos.push({
          id,
          url: `${await deps.server.origin()}${mount}`,
          name,
          mime,
          size,
          addedAt,
          member: { key, name: memberName },
        });
      }
    }

    photos.sort((a, b) => b.addedAt - a.addedAt);
    return photos;
  }

  async function spoolToFile(drive: Drive, drivePath: string, spoolPath: string) {
    if (fs.existsSync(spoolPath)) return;
    fs.mkdirSync(path.dirname(spoolPath), { recursive: true });
    // Unique tmp per call so concurrent spools of the same photo never collide;
    // rename is atomic (last write wins, content is identical).
    const tmp = `${spoolPath}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    const stream = drive.createReadStream(drivePath);
    await pumpToFile(stream, tmp);
    fs.renameSync(tmp, spoolPath);
  }

  async function seedSamplePhotos() {
    const existing = (await getText(ownDrive, DRIVE_PATH_PHOTOS)) ? 1 : 0;
    if (existing) return;
    try {
      const list = ownDrive.list(DRIVE_PATH_PHOTOS);
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
      const id = newId();
      await ownDrive.put(`${DRIVE_PATH_PHOTOS}/${id}.jpg`, sample.data, {
        metadata: { addedAt: addedAt + i * 60_000, name: sample.name, mime: sample.mime },
      });
    }
    console.log("[justus] seeded sample photos");
  }

  async function setup(): Promise<void> {
    await corestore.ready();
    state = loadState();
    ownDrive = new Hyperdrive(corestore);
    await ownDrive.ready();
    await ensureOwnDriveIdentity();

    // Swarm: seed our own identity drive; replicate everything over each conn.
    // Registered before any topic join so early connections replicate too.
    swarm.on("connection", (conn: any) => {
      conn.on("error", () => {});
      try {
        corestore.replicate(conn);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error(`[justus] replicate failed: ${message}`);
      }
    });
    await joinTopic(ownDrive.discoveryKey);

    const ownKey = hex(ownDrive.key);
    if (state.folder && state.folder.shareKey !== ownKey) {
      folderDrive = await openDriveWithTopic(state.folder.shareKey, { server: false });
      await refreshMembers();
      role = members.some((m) => m.key === ownKey) ? "member" : "reader";
      state.folder = { role, shareKey: state.folder.shareKey };
      saveState();
    } else {
      folderDrive = ownDrive;
      role = "creator";
      state.folder = { role, shareKey: ownKey };
      saveState();
    }

    watchDrive(ownDrive, ownKey);
    if (folderDrive !== ownDrive) watchDrive(folderDrive, hex(folderDrive.key));

    if (deps.seedOnEmpty) await seedSamplePhotos();
  }

  function guessMime(ext: string): string {
    switch (ext.toLowerCase()) {
      case ".png":
        return "image/png";
      case ".gif":
        return "image/gif";
      case ".webp":
        return "image/webp";
      case ".heic":
        return "image/heic";
      case ".mp4":
        return "video/mp4";
      case ".mov":
        return "video/quicktime";
      default:
        return "image/jpeg";
    }
  }

  return {
    async ready() {
      if (readyPromise) return readyPromise;
      readyPromise = setup();
      return readyPromise;
    },

    async list() {
      await readyPromise;
      return listPhotos();
    },

    async add(filePath) {
      return addFromPath(filePath);
    },

    /** Adds a photo from bytes uploaded in-band (browser multi-file picker):
     * stages the bytes to a temp file so the path-based flow stays the single
     * source of truth, then imports it. */
    async addBytes(name, bytes) {
      await readyPromise;
      if (role === "reader") {
        return err(PhotoError.NOT_A_MEMBER, "Readers cannot add photos");
      }
      const safeName = typeof name === "string" && name.trim() ? name.trim() : `photo-${newId()}`;
      const ext = path.extname(safeName).toLowerCase();
      const staged = path.join(deps.cacheDir, `upload-${newId()}${ext}`);
      try {
        fs.writeFileSync(staged, bytes as Buffer);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return err(ErrorCode.HOST_ERROR, `Failed to stage upload: ${message}`);
      }
      try {
        return await addFromPath(staged);
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
      const selfKey = hex(ownDrive.key);
      // Own photo → delete from own drive.
      const ownEntries: string[] = [];
      try {
        const list = ownDrive.list(DRIVE_PATH_PHOTOS);
        for await (const entry of list) {
          const base = (entry as { key: string }).key.slice(DRIVE_PATH_PHOTOS.length + 1);
          ownEntries.push(base);
        }
      } catch {
        // no photos
      }
      const match = ownEntries.find((base) => base.startsWith(`${id}.`) || base === id);
      if (match) {
        await ownDrive.del(`${DRIVE_PATH_PHOTOS}/${match}`);
        deps.onChanged({ cause: "remove", memberKey: selfKey });
        return ok({ id });
      }
      // Creator → tombstone another member's photo out of the derived view.
      if (role === "creator") {
        const text = await getText(folderDrive, DRIVE_PATH_REMOVED);
        let removed: RemovedFile["removed"] = {};
        if (text) {
          try {
            const parsed = JSON.parse(text) as { removed?: unknown };
            if (isTextJSON(parsed.removed)) removed = parsed.removed as RemovedFile["removed"];
          } catch {
            // start fresh
          }
        }
        let tombstoned = false;
        for (const key of memberDrives.keys()) {
          try {
            const list = memberDrives.get(key)!.list(DRIVE_PATH_PHOTOS);
            for await (const entry of list) {
              const base = (entry as { key: string }).key.slice(DRIVE_PATH_PHOTOS.length + 1);
              if (base.startsWith(`${id}.`) || base === id) {
                removed[`${key}:${id}`] = { memberKey: key, removedAt: Date.now() };
                tombstoned = true;
              }
            }
          } catch {
            // skip
          }
        }
        if (tombstoned) {
          await folderDrive.put(
            DRIVE_PATH_REMOVED,
            Buffer.from(JSON.stringify({ version: 1, removed })),
          );
          deps.onChanged({ cause: "remove" });
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
      let drive: Drive;
      try {
        // Join the folder topic first so a peer serves the drive's blocks
        // (a remote `drive.ready()` otherwise waits forever).
        drive = new Hyperdrive(corestore, Buffer.from(key, "hex"));
        const topic = drive.discoveryKey;
        await joinTopic(topic, { server: false });
        await Promise.race([
          drive.ready(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("timeout opening folder")), 45_000),
          ),
        ]);
        await readRegistryIn(drive);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return err(PhotoError.INVALID_KEY, `Cannot open folder: ${message}`);
      }
      // The registry tells us whether this device is enrolled as a member.
      const registry = await readRegistryIn(drive);
      const enrolled = Object.values(registry.members).some((m) => m.key === hex(ownDrive.key));
      const nextRole: FolderRole = enrolled ? "member" : "reader";
      await switchFolder(key, nextRole);
      await refreshMembers();
      watchDrive(folderDrive, hex(folderDrive.key));
      deps.onChanged({ cause: "enroll" });
      return ok(await status());
    },

    async enroll(key, name) {
      await readyPromise;
      if (role !== "creator")
        return err(PhotoError.NOT_CREATOR, "Only the creator can enroll members");
      if (!isHexKey(key)) return err(PhotoError.INVALID_KEY, "Drive key must be a 64-char hex key");
      if (key === hex(ownDrive.key))
        return err(PhotoError.INVALID_KEY, "You cannot enroll yourself");
      const registry = await readRegistry();
      if (registry.members[key]) {
        return err(PhotoError.ALREADY_ENROLLED, "Member already enrolled");
      }
      registry.members[key] = { key, name, addedAt: Date.now() };
      await folderDrive.put(DRIVE_PATH_MEMBERS, Buffer.from(JSON.stringify(registry)));
      await loadMemberDrive(key, name);
      deps.onChanged({ cause: "enroll", memberKey: key });
      return ok(await status());
    },

    async status() {
      await readyPromise;
      return status();
    },

    async close() {
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

  async function status(): Promise<SyncStatus> {
    const registry = await readRegistry();
    const memberList: SyncMember[] =
      role === "creator"
        ? [{ key: hex(ownDrive.key), name: state.name }, ...Object.values(registry.members)]
        : Object.values(registry.members).map((m) => ({ key: m.key, name: m.name }));
    const photos = (await listPhotos()).length;
    return {
      role,
      name: state.name,
      driveKey: hex(ownDrive.key),
      shareKey: hex(folderDrive.key),
      discoveryKey: hex(ownDrive.discoveryKey),
      peers: swarm.connections.size,
      photos,
      members: memberList,
    };
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

  /** Shared import logic for `add` (host path) and `addBytes` (in-band bytes):
   * validates, reads, stores on the own drive and mounts for loopback serving. */
  async function addFromPath(filePath: string): Promise<EitherResult<Photo>> {
    await readyPromise;
    if (role === "reader") {
      return err(PhotoError.NOT_A_MEMBER, "Readers cannot add photos");
    }
    let stat: ReturnType<typeof fs.statSync>;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return err(PhotoError.NOT_FOUND, `No file at ${filePath}`);
    }
    if (!stat.isFile()) {
      return err(PhotoError.NOT_FOUND, `Not a file: ${filePath}`);
    }
    let bytes: unknown;
    try {
      bytes = fs.readFileSync(filePath);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return err(ErrorCode.HOST_ERROR, `Failed to read file: ${message}`);
    }
    const name = path.basename(filePath);
    const ext = path.extname(name).toLowerCase();
    const mime = guessMime(ext);
    const id = newId();
    const drivePath = `${DRIVE_PATH_PHOTOS}/${id}${ext}`;
    const metadata: PhotoMeta = { addedAt: Date.now(), name, mime };
    try {
      await ownDrive.put(drivePath, bytes, { metadata });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return err(ErrorCode.PLUGIN_ERROR, `Failed to store photo: ${message}`);
    }
    const spoolPath = path.join(spoolDir, `${hex(ownDrive.key).slice(0, 12)}-${id}${ext}`);
    try {
      await spoolToFile(ownDrive, drivePath, spoolPath);
    } catch {
      // spool failure is non-fatal — the drive has the bytes
    }
    const mount = `/photos/${hex(ownDrive.key).slice(0, 12)}-${id}`;
    if (!mounted.has(mount)) {
      deps.server.mount(mount, spoolPath);
      mounted.add(mount);
    }
    deps.onChanged({ cause: "add", memberKey: hex(ownDrive.key) });
    return ok({
      id,
      url: `${await deps.server.origin()}${mount}`,
      name,
      mime,
      size: stat.size,
      addedAt: metadata.addedAt,
      member: { key: hex(ownDrive.key), name: state.name },
    });
  }
}

// Seed data: real generated JPEGs (480x320 gradients), dev only.
const SAMPLE_1 = Buffer.from(
  "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",
  "base64",
);
const SAMPLE_2 = Buffer.from(
  "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",
  "base64",
);
const SAMPLE_3 = Buffer.from(
  "/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAB4KADAAQAAAABAAABQAAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgBQAHgAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwUDAwMFBgUFBQUGCAYGBgYGCAoICAgICAgKCgoKCgoKCgwMDAwMDA4ODg4ODw8PDw8PDw8PD//bAEMBAgICBAQEBwQEBxALCQsQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEP/dAAQAHv/aAAwDAQACEQMRAD8A9BzipAcVCOlSA5r450z+mJTJQe9PBzUYNSDpWbpmUpk2cU8HvUK1ID2rJ0zFzJQc1NnFQA+tSLWbpmUpkwPeng5qIHtUg6Vm6ZjKZNUgqFakB7Vk6ZjKZKDmpAc1EOlSLWbpmUpkwp4OahHWpAcVk6Zk5kwOalFQg+tPB5rN0zFzJgc1IDmoQcVKtZOmYymTDpT16VCDzUgOKzdMycyYHNSA9qiWng81k6ZjKoTL0qQHNQZ9KlBxWbpmUpEwPapF6VCKfn0rN0zGVQnBzUgPaoQcVIKydMxlMlBxUi1Dn0qSs3TMZTJgecVIDioQe9SA1k6ZlKZMtSA84qHPpUgPes3TMnMmBxUi1ADmpc+lZOmYymSjrUmcVED3p4OazdMxlMmBxUi9aiz6VIKydMycyXOKkBxUI6VIDWbpmMpky9akzioQakHSs3TMnMmBxUi9ahBzUgNZOmYuZLUucVCOlSA5rN0zKUyUHvTwc1GDTwfWsnTMZSJ84p4PeoVqQHtWbpmMqhKDmps4qAH1qRaydMylImB708HNRA9qkHSs3TMXMlBzUoqFaeOtZOmYymf/0O9zipAcVCOlSA1846Z/RrmTL1qTOKhBqQdKydMxlMmBxUi9ahBzUgNZumZSmS1LnFQjpT1rJ0zGUyYHvTwc1ED2qQH1rN0zGUyfOKeD3qFakB7Vk6Zk5koOamzioB0qRazdMxlMmB708HNRA9qkHSs3TMnMlBzUoqFaeOtZOmYuZMDmpAc1CDipQfWs3TMpTJhTwc1CDzUgOKydMxlImBzUo6VCtPB5rN0zFzJl6VIDmoQcVKtZOmZSmSg9qkXpUIPNPz6Vm6Zk5k4OakB7VCDipAaydMwlMmXpUgOagz6VKDis3TMnMmB7VIvSoRT8+lZumYymTLUgPOKhqQHvWTpmUpkwOKkWoQakz6Vm6ZjKZMDzipAcVCD3p4OaydMylMnWpAecVDn0qQHvWbpmLmS5xUgOKhBzUufSsnTMpTJV61JnFRCnjpWbpmMpkwOKkXrUINSA1k6ZjKZNnFSA4qEdKkBzWbpmUpky9afUQNSDpWbpmTmTZxTwe9RA5qQGsnTMXMkBzU2cVAD61ItZumYymTA96eDmoge1SA+tZOmZOZPnFPB71CtSA9qzdMwlM//R7nOKkBxUIOalz6V5Lpn9AymSr1qTOKiFPHSs3TMpVCYHFSL1qEGpAaydMxlMmzipAcVCOlSA5rN0zGUyZetPqIGpB0rJ0zKUybOKeD3qIHNPB7Vm6Zi5koOamzioAfWpFrJ0zKUyYHvTwc1ED2qQdKzdMxlMnzing96hWpAe1ZOmYymSg5qQHNRDpUi1m6ZlKZMKeDmoR1qQHFZumZOZMDmpRUIPrTweaydMxcyYHNSA5qEHFSrWbpmMpkw6U9elQg81IDisnTMnMmBzUgPaolp4PNZumYyqEy9KkBzUFSg4rJ0zKUiYHtUi9KhBp+fSs3TMZVCcHNSA9qhBxUgrJ0zGUyZelPWoc+lSg4rN0zGUyUHnFSA4qEHvUgNZumZSmTLUgPOKhz6VID3rJ0zJzJgcVItQA5qXPpWbpmMpkwPOKkBxUIPeng5rJ0zGUyYHFSL1qLPpUgrN0zJzJc4qQHFQjpUgNZOmYymTL1qTOKhBqQdKzdMycyYHFSL1qEHNSA1k6Zi5ktS5xUI6VIDms3TMpTJQe9PBzUYNSDpWbpmMpE2cU8HvUK1ID2rJ0zGVQ//S7YHFSLUAOalz6VzOmfu0pEwPOKfnFRA96eDms3TMXMmBxUi9aiz6VIKydMxlMlzipAcVCOlSA1m6Zk5ky9akzioQakHSs3TMZTJgcVIvWoQc1IDWTpmUpktS5xUI6VIDms3TMZTJQe9PBzUYNPB9aydMxlMnzing96hWpAe1ZumZOZKDmps4qAH1qRaydMxlMmB708HNRA9qkHSs3TMnMlBzUoqFaeOtZOmYuZMDmpAc1CDipQfWs3TMpTJhTwc1CDzUgOKzdMxlImBzUoqFaeDzWTpmLmTA5qQHNQg4qVazdMylMlB7VIvSoQeafWTpmTmTg5qQHtUIOKkBrN0zCUyZelSA5qDPpUoOKydMylMmB7VIvSoRT8+lZumYymTLUgPOKiBxUgrJ0zKUyUHFSLUOfSpM+lZumYymTA84qQHFQg96kBrN0zKUyZakB5xUOfSpAe9ZOmYuZMDipFqAHNS59KzdMylMlHWpM4qIU8dKydMxlMmBxUi9ahBqQGs3TMZTJs4qQHFQjpUgOaydMylMmXrUmcVCDUg6Vm6Zk5k2cU8HvUQOakBrJ0zFzP/T7IHFSLUINSZ9K1dM/apTJgecVIDioQe9PBzWTpmTmTrUgPOKhz6VID3rN0zCUyYHFPBxUIOalz6Vk6ZlKZKvWpM4qIU8dKzdMylUJgcVIvWoQakBrJ0zGUybOKkBxUI6VIDms3TMZTJl60+ogakHSs3TMpTJs4p4Peogc1IDWTpmLmSA5qbOKhHSnrWbpmUpkwPeng5qIHtUgPrWTpmMpk+cU8HvUK1ID2rN0zGUyUHNS1COlSLWTpmUpkwp4OahHWpAcVm6Zk5kwOalFQg+tPB5rJ0zFzJgc1IDmoQcVKD61m6ZjKZMKeDmoQeakBxWbpmTmTA5qQHtUS08HmsnTMZVCZelSA5qCpQcVm6ZlKRMD2qRelQg0/PpWTpmLmTg5qQHtUIOKkFZumYymTL0p61Dn0qUHFZOmYymSg84qQHFRCn59KzdMylMmWpAecVDUgPesnTMnMmBxUi1CDUmfSs3TMZTJgecVIDioQe9PBzWbpmMpk608daiz6VID3rJ0zJzJc4qQHFQg5qQGs3TMZTJl61JnFQg1IOlZOmZOZMDipF61CDUgNZumYuZ/9Tr16U9ahz6VKDivSdM/XpTJQecVIDioQe9SA1m6Zk5ky1IDzioc+lSA96ydMxlUJgcVItQg1Jn0rN0zKUiYHnFSA4qEHvTwc1k6Zi5kwOKkXrUWfSpBWbpmMpkucVIDioR0qQGsnTMnMmXrUmcVCDUg6Vm6ZjKZMDipF61CDmpAaydMylMmzipM4qEdKkBzWbpmMpkoPeng5qMGpB0rN0zGUybOKeD3qFakB7Vk6Zk5koOamzioAfWpFrN0zGUyYHvTwc1ED2qQdKydMycyapBUK1ID2rN0zFzJQc1IDmoQcVKD61k6ZlKZMKeDmoQeakBxWbpmMpEwOalFQg+tPB5rJ0zFzJgc1IDmoQcVKtZumZSmSg9qkXpUIPNPrN0zJzJwc1ID2qEHFSA1k6ZhKZMvSpAc1Bn0qUHFZumZSmTA9qkXpUIp+fSsnTMZTJwc08HnFRA4qQVm6ZlKZKDipFqHPpUlZOmYymTA84qQHFQg96kBrN0zKUyZakB5xUOfSpAe9ZOmYuZMDipFqAHNS59KzdMylMlHWpM4qIHvTwc1m6ZjKZMDipF61Fn0p4NZOmYymf/1erXpUgOagz6VKDivfdM/U5TJge1SL0qEU/PpWbpmMpEy1IDziogcVIKydMxcyUHFSLUOfSpM+lZumZSmTA84qQHFQg96kBrN0zJzJlqQHnFQ59KkB71k6ZhKZMDipFqAHNS59KzdMylMlHWpM4qIHvTwc1k6ZlKoTA4qRetQg1IDWbpmMpk2cVIDioR0qQHNZOmYymTL1qTOKhBqQdKzdMylMmBxTwe9RA5qQGsnTMXMkBzU2cVCOlPWs3TMpTJge9PBzUQPapAfWs3TMZTJ84p4PeoVqQHtWTpmMpkoOalqEdKkWs3TMpTJhTwc1ED2qQdKydMycyUHNSioQfWng81m6Zi5kwOakBzUIOKlB9aydMxlMmFPBzUIPNSA4rN0zJzJgc1KOlQrTweaydMxlUJl6VIDmoQcVIDis3TMpSJge1SL0qEGn59KzdMxcycHNSA9qhBxUgrJ0zGUyZelSA5qDPpUoOKzdMxlMmB7U8HFRCn59KydMylMmWpAecVDUgPes3TMnMmBxUi1CDUmfSsnTMZTJgecVIDioQe9PBzWbpmMpk608daiz6VID3rJ0zJzP/W6delSA5qCpQcV9a6Z+jymTA9qkXpUINPz6Vk6Zk5k4OakB7VCDipBWbpmLmTL0p61Dn0qUHFZOmYymSg84qQHFRCn59KzdMycyZakB5xUNSA96ydMxlUJgcVItQg1Jn0rN0zKUiYHnFSA4qEHvTwc1m6Zi5k608daiz6VID3rJ0zGUyXOKkBxUIOakBrN0zJzJl61JnFQg1IOlZOmYymTA4qRetQg1IDWbpmUpk2cVIDioR0qQHNZOmYymTL1p9RA1IOlZumYymTZxTwe9QrUgPasnTMnMlBzU2cVAD61ItZumYymTA96eDmoge1SDpWbpmTmTVIKhWpAe1ZOmYuZKDmpAc1EOlSLWbpmUpkwp4OahHWpAcVk6ZjKRMDmpRUIPrTweazdMxcyYHNSA5qEHFSrWTpmUpkw6U9elQg81IDis3TMnMmBzUgPaoQcVIDWTpmEpky9KkBzUGfSpQcVm6ZlKZMD2qRelQg0/PpWbpmMpk4OakB7VCDipBWTpmUpky9KetQ59KkrN0zGUyYHnFSA4qEHvUgNZOmZSmTLUgPOKhz6VID3rN0zFzP/9fowc1IDmoQcVKtfdOmfdymTDpT16VCDzT6zdMycycHNSA9qhBxUgNZOmYuZMvSpAc1Bn0qUHFZumZSmTA9qkXpUIp+fSsnTMZSJwc08HnFRA4qQVm6Zi5koOKkWoc+lSVk6ZlKZMDzipAcVCD3qQGs3TMnMmWpAecVDn0qQHvWTpmEpkwOKkWoAc1Ln0rN0zKUyUdakzioge9PBzWbpmUqhMDipF61Fn0p4NZOmYymTZxUgOKhHSpAazdMxlMmXrUmcVCDUg6Vk6ZlKZMDipF61CDmpAazdMxcyWpc4qEdKkBzWTpmUpkoPeng5qIHtUgPrWbpmMpk+cU8HvUK1ID2rJ0zGUyUHNTZxUA6VItZumZSmTA96eDmoge1SDpWbpmTmSg5qUVCtPHWsnTMXMmBzUgOahBxUoPrWbpmMpkwp4OahB5qQHFZOmZOZMDmpR0qFaeDzWbpmMqhMvSpAc1CDipVrJ0zKUiUHtUi9KhB5p+fSs3TMXMnBzUgPaoQcVIDWTpmMpky9KkBzUGfSpQcVm6ZjKZMD2qRelQin59KzdMylMmWpAecVEDing96ydMycz//0N8HNSA5qEHFSg+tfo7pn2Epkwp4OahB5qQHFZumYymTA5qUdKhWng81k6ZjKZMvSpAc1CDipAcVm6ZlKZMD2qRelQg0/PpWbpmTmTg5qQHtUIOKkBrJ0zFzJl6VIDmoM+lSg4rN0zGUyYHtTwcVEKfn0rJ0zJzJlqQHnFQ1ID3rN0zGVQmBxUi1CDUmfSsnTMpSJgecVIDioQe9PBzWbpmLmTrTx1qLPpUgPesnTMZTJc4qQHFQg5qXPpWbpmTmSr1qTOKiFPHSs3TMZTJgcVIvWoQakBrJ0zKUybOKkBxUI6VIDms3TMZTJl60+ogakHSsnTMZTJs4p4Peogc08HtWbpmTmSg5qbOKgB9akWsnTMZTJge9PBzUQPapAfWs3TMnMnzing96hWpAe1ZOmYuZKDmpAc1EOlSLWbpmUpkwp4OahHWpAcVm6ZjKRMDmpRUIPrTweaydMxcyYHNSA5qEHFSrWbpmUpkw6U9elQg81IDisnTMnMmBzUgPaolp4PNZumYSmTL0qQHNQVKDisnTMpTJge1SL0qEGn59KzdMxlMnBzUgPaoQcVIKydMylM//0dsHNSA5qIdKkWv1V0z6SUyYU8HNQjrUgOKydMylMmBzUoqEH1p4PNZumYuZMDmpAc1CDipVrJ0zGUyYdKevSoQeakBxWbpmTmTA5qQHtUS08HmsnTMXMmXpUgOagz6VKDis3TMpTJge1SL0qEGn59KzdMxlInBzUgPaoQcVIKydMxcyZelPWoc+lSVm6ZlKZMDzipAcVCD3qQGsnTMnMmWpAecVDn0qQHvWbpmEpkwOKkWoAc1Ln0rJ0zKUyYHnFSA4qEHvTwc1m6ZlKoTA4qRetRZ9KkFZOmYymS5xUgOKhHSpAazdMxlMmXrUmcVCDUg6Vm6ZlKZMDipF61CDmpAaydMxcyWpc4qEdKkBzWbpmUpkoPeng5qMGng+tZOmYymT5xTwe9QrUgPas3TMZTJQc1NnFQA+tSLWTpmUpkwPeng5qIHtUg6Vm6Zk5k1SCoVp461k6Zi5kwOakBzUIOKlB9azdMxlMmFPBzUIPNSA4rN0zJzJgc1KKhWng81k6ZjKoTA5qQHNQg4qVazdMylIlB7VIvSoQeafWTpmLmTg5qQHtUIOKkBrN0zGUz//0tcHNTZxUA6VItfsTpnsSmTA96eDmoge1SDpWbpmUpkoOalFQrTx1rJ0zJzJgc1IDmoQcVKD61m6ZjKZMKeDmoQeakBxWTpmMpkwOalHSoVp4PNZumYymTL0qQHNQg4qVaydMylMlB7VIvSoQeafWbpmTmTg5qQHtUIOKkBrJ0zFzJl6VIDmoM+lSg4rN0zGUyYHtUi9KhFPz6Vm6Zk5ky1IDziogcU8HvWTpmMqhMDipFqEGpM+lZumZSkTA84qQHFQg96kBrJ0zFzJlqQHnFQ59KkB71m6ZjKZMDing4qEHNS59KydMycyVetSZxUQp46Vm6ZjKZMDipF61CDUgNZOmZSmTZxUgOKhHSpAc1m6ZjKZMvWn1EDUg6Vm6ZjKZNnFPB71EDmpAaydMycyQHNTZxUI6U9azdMxlMmB708HNRA9qkB9aydMycyfOKeD3qFakB7Vm6Zi5koOalqEdKkWsnTMpTJhTwc1ED2p4OKzdMxlImBzUoqEH1p4PNZOmYuZMDmpAc1CDipQfWs3TMpTJhTwc1CDzUgOKzdMycyYHNSA9qiWng81k6ZhKZ//09MHNTZxUAPrUi1+3umdrmTA96eDmoge1SA+tZumYymT5xTwe9QrUgPasnTMpTJQc1LUI6VItZumYymTCng5qEdakBxWbpmUpkwOalFQg+tPB5rJ0zFzJgc1IDmoQcVKtZumYymTCng5qEHmpAcVk6Zk5kwOakB7VEtPB5rN0zFzJl6VIDmoKlBxWTpmUpkwPapF6VCDT8+lZumYykTg5qQHtUIOKkFZOmYuZMvSnrUOfSpQcVm6ZlKZKDzipAcVEKfn0rN0zJzJlqQHnFQ59KkB71k6ZhKZMDipFqEGpM+lZumZSmTA84qQHFQg96eDmsnTMpVCdaeOtRZ9KkFZumYymS5xUgOKhHSpAaydMxlMmXrUmcVCDUg6Vm6ZlKZMDipF61CDmpAaydMxcybOKkzioR0qQHNZumZSmSg96eDmowakHSs3TMZTJs4p4PeoVqQHtWTpmMpkoOamzioAfWpFrN0zKUyYHvTwc1ED2qQdKydMycyapBUK1ID2rN0zFzJQc1IDmoh0qQH1rJ0zGUyYU8HNQg81IDis3TMnMmBzUoqEH1p4PNZumYyqH//U0KlzioR0qQHNfvrpjlMlB708HNRg1IOlZOmZSqE2cU8HvUK1ID2rN0zGUyUHNTZxUAPrUi1k6ZjKZMD3p4OaiB7VIOlZumZSmTVIKhWpAe1ZOmZOZKDmpAc1CDipQfWs3TMZTJhTwc1CDzUgOKzdMxlMmBzUoqFaeDzWTpmMpkwOakBzUIOKlWs3TMpTJQe1SL0qEHmn1k6Zk5k4OakB7VCDipAazdMxcyZelSA5qDPpUoOKydMxlMmB7VIvSoRT8+lZumZOZMtSA84qIHFSCsnTMZVCUHFSLUOfSpKzdMylImB5xUgOKhB71IDWbpmLmTLUgPOKhz6VID3rJ0zGUyYHFSLUAOalz6Vm6Zk5ko61JnFRA96eDmsnTMZTJgcVIvWoQakBrN0zKUybOKkBxUI6VIDmsnTMZTJl61JnFQg1IOlZumYymTA4p4Peogc1IDWTpmTmSA5qbOKhHSnrWbpmMpkwPeng5qIHtUgPrWbpmTmT5xTwe9QrUgPasnTMXMlBzUtQjpUi1m6ZlKZMKeDmoge1SDpWbpmMpEoOalFQrTx1rN0zFzP/1bucVIDioR0qQHNf0U6ZyykTL1qTOKhBqQdKzdMxcybOKeD3qIHNSA1k6ZjKZIDmps4qEdKetZumZOZMD3p4OaiB7VID61k6ZjKZPnFPB71CtSA9qzdMylMlBzUtQjpUi1k6ZjKZMKeDmoge1PBxWbpmUpkwOalFQg+tPB5rJ0zFzJgc1IDmoQcVKD61m6ZjKZMKeDmoQeakBxWbpmTmTA5qUdKhWng81k6Zi5ky9KkBzUFSg4rN0zKUyYHtUi9KhBp+fSsnTMZSJwc1ID2qEHFSCs3TMXMmXpUgOagz6VKDisnTMpTJQecVIDiohT8+lZumZOZMtSA84qGpAe9ZOmYSmTA4qRahBqTPpWbpmUpkwPOKkBxUIPeng5rN0zKVQnWnjrUWfSpAe9ZOmYymS5xUgOKhBzUgNZumYymTL1qTOKhBqQdKydMylMmBxUi9ahBqQGs3TMXMmzipAcVCOlSA5rJ0zKUyZetPqIGpB0rN0zGUybOKeD3qFakB7Vm6ZjKZKDmps4qAH1qRazdMylMmB708HNRA9qkHSs3TMnMnzing96hWpAe1ZOmYuZ//1rOcVIDioR0qQGv6XdM8mUyZetSZxUINSDpWbpmTmTA4qRetQg1IDWTpmEpk2cVJnFQjpUgOazdMylMlB708HNRg1IOlZumZSqE2cU8HvUK1ID2rJ0zGUyUHNTZxUAPrUi1m6ZjKZMD3p4OaiB7VIOlZOmZSmTVIKhWpAe1ZumZOZKDmpAc1EOlSLWTpmMpkwp4OahHWpAcVm6ZjKZMDmpRUIPrTweaydMxlMmBzUgOahBxUq1m6ZlKZMOlPXpUIPNSA4rN0zJzJgc1ID2qEHFSA1k6Zi5ky9KkBzUGfSpQcVm6ZjKZMD2qRelQg0/PpWTpmTmTg5p4POKiBxUgrN0zGVQlBxUi1Dn0qSsnTMpSJgecVIDioQe9SA1m6Zi5ky1IDzioc+lSA96ydMxlMmBxUi1ADmpc+lZumZOZKOtSZxUQPeng5rN0zGUyYHFSL1qLPpUgrJ0zKUyXOKkBxUI6VIDWbpmMpky9akzioQakHSs3TMZTJgcVIvWoQc1IDWbpmTmS1LnFQjpUgOazdMxlMlB708HNRA9qkB9aydMycyfOKeD3qFakB7Vm6Zi5n/9eYHFSLUAOalz6V/Urpnzspko61JnFRA96eDmsnTMnMmBxUi9ahBqQGs3TMZVCbOKkBxUI6VIDWTpmUpEy9akzioQakHSs3TMXMmBxTwe9RA5qQGsnTMZTJAc1NnFQjpT1rN0zJzJge9PBzUQPapAfWs3TMZTJ84p4PeoVqQHtWTpmUpkoOamzioB0qRazdMxlMmB708HNRA9qkHSsnTMpTJQc1KKhWnjrWbpmLmTA5qQHNQg4qUH1rJ0zGUyYU8HNQg81IDis3TMnMmBzUo6VCtPB5rJ0zFzJl6VIDmoQcVKtZumZSmSg9qkXpUIPNPz6Vm6ZjKRODmpAe1Qg4qQGsnTMXMmXpUgOagz6VKDis3TMpTJge1PBxUQp+fSsnTMnMmWpAecVDUgPes3TMJTJgcVItQg1Jn0rJ0zKUyYHnFSA4qEHvTwc1m6ZlKoTrUgPOKhz6VID3rN0zGUyXOKkBxUIOalz6Vm6ZjKZKvWpM4qIU8dKzdMylMmBxUi9ahBqQGsnTMXMmzipAcVCOlSA5rN0zKUyZetPqIGpB0rN0zGUybOKeD3qIHNSA1k6ZjKZ//9BwOKkWoQakz6V/WTpnyUpkwPOKkBxUIPeng5rN0zGUydaeOtRZ9KkB71k6ZjKoS5xUgOKhBzUufSs3TMpTJV61JnFQg1IOlZOmZOZMDipF61CDUgNZumYSmTZxUgOKhHSpAc1k6ZlKZMvWn1EDUg6Vm6ZlKoTZxTwe9RA5p4PasnTMZTJQc1NnFQA+tSLWbpmMpkwPeng5qIHtUg6Vm6ZlKZPnFPB71CtSA9qydMycyUHNSA5qIdKkWs3TMZTJhTwc1COtSA4rJ0zGUyYHNSioQfWng81m6ZjKZMDmpAc1CDipVrJ0zKUyYdKevSoQeakBxWbpmTmTA5qQHtUS08HmsnTMXMmXpUgOagqUHFZumYymTA9qkXpUINPz6Vm6Zk5k4OakB7VCDipBWTpmMqhMvSnrUOfSpQcVm6ZlKRKDzipAcVCD3qQGs3TMXMmWpAecVDn0qQHvWbpmMpkwOKkWoAc1Ln0rN0zJzJgecU/OKiB708HNZOmYymTA4qRetRZ9KkFZumZOZLnFSA4qEdKkBrJ0zGUyZetSZxUINSDpWbpmMpkwOKkXrUIOakBrJ0zJzP/RRelPWoc+lSV/X7pnw0pkwPOKkBxUIPepAazdMycyZakB5xUOfSpAe9ZOmYuZMDipFqAHNS59KzdMxlMlHWpM4qIHvTwc1m6Zk5kwOKkXrUWfSpBWTpmMqhLnFSA4qEdKkBrN0zKUiZetSZxUINSDpWTpmLmTA4qRetQg5qQGs3TMZTJalzioR0qQHNZOmZOZKD3p4OaiB7VID61m6ZjKZPnFPB71CtSA9qydMylMlBzU2cVAD61ItZumYymTA96eDmoge1SDpWbpmUpk1SCoVp461k6Zi5kwOakBzUIOKlB9azdMxlMmFPBzUIPNSA4rJ0zJzJgc1KKhWng81m6Zi5kwOakBzUIOKlWsnTMpTJQe1SL0qEHmn1m6ZjKRODmpAe1Qg4qQGs3TMXMmXpUgOagz6VKDis3TMpTJge1SL0qEU/PpWbpmTmTLUgPOKiBxTwe9ZOmYSmTA4qRahBqTPpWbpmUpkwPOKkBxUIPepAazdMylUJlqQHnFQ59KkB71k6ZjKZMDipFqAHNS59KzdMxlMlHWpM4qIU8dKydMylMmBxUi9ahBqQGs3TMXM//SiXpUgOagz6VKDiv7NdM/O5TJge1SL0qEU/PpWTpmMpky1IDzioakB71m6ZjKZMDipFqEGpM+lZOmZSmTA84qQHFQg96eDms3TMZTJ1qQHnFQ59KkB71k6ZjKoS5xUgOKhBzUufSs3TMpTJV61JnFRCnjpWbpmTmTA4qRetQg1IDWTpmEpk2cVIDioR0qQHNZumZSmTL1p9RA1IOlZOmZSqE2cU8HvUQOakBrN0zGUyQHNTZxUAPrUi1k6ZjKZMD3p4OaiB7VID61m6ZlKZPnFPB71CtSA9qydMycyUHNS1COlSLWbpmMpkwp4OahHWpAcVm6ZjKZMDmpRUIPrTweaydMxlMmBzUgOahBxUq1m6ZlKZMKeDmoQeakBxWbpmTmTA5qQHtUS08Hms3TMXMmXpUgOagqUHFZumYymTA9qkXpUINPz6Vk6Zk5k4OakB7VCDipBWbpmMqhMvSnrUOfSpQcVk6ZlKRKDzipAcVEKfn0rN0zFzJlqQHnFQ59KkB71k6ZjKZMDipFqEGpM+lZumZOZMDzipAcVCD3p4OazdMxlMnWnjrUWfSpBWTpmUpn/9k=",
  "base64",
);
