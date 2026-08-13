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
    await handle.flushed?.().catch(() => {});
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
    const tmp = `${spoolPath}.tmp`;
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
      corestore.replicate(conn);
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
}

// Seed data: tiny hand-rolled JPEGs (dev only).
const SAMPLE_1 = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/AX//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/AX//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Aqf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IV//2gAMAwEAAgADAAAAEP/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8Qf//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8Qf//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8Qf//Z",
  "base64",
);
const SAMPLE_2 = SAMPLE_1;
const SAMPLE_3 = SAMPLE_1;
