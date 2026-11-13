/**
 * What an album's own drives hold, and the drive work of creating, naming,
 * listing, moving to a new key and removing a member, over the drive port. photo-store keeps the
 * saved records, swarm topics, invites and notifications.
 */
import type { Drive, DriveStore } from "../ports/drive-store";
import type { FolderNotice, FolderSummary, InvitedFriend, Role } from "@justus/core";
import {
  parseFolderName,
  parseRegistry,
  parseRemoved,
  type RegistryFile,
} from "../membership/records";
import { copyAlbumEntries } from "../rotate-album";
import { liveOwed, type OwedOffers } from "../membership/offers";
import { errText, type P2pLog } from "../p2p-log.ts";
import { readRecord } from "../membership/join.ts";

const DRIVE_PATH_DEVICE = "/device.json";
const DRIVE_PATH_FOLDER = "/folder.json";
const DRIVE_PATH_MEMBERS = "/members.json";
const DRIVE_PATH_REMOVED = "/removed.json";

export type AlbumLog = P2pLog;

export type AlbumError =
  | { kind: "write-failed"; message: string }
  | { kind: "no-such-member"; message: string }
  | { kind: "rotate-failed"; message: string };
/** The repo's error tuple (ADR 0002 decision 8). */
export type AlbumResult<T> = [AlbumError, null] | [null, T];

/** Opens the new album's own drive (namespace `folder/<id>`, never the identity
 * drive) and writes who made it and its name. */
export async function createAlbumDrive(
  drives: DriveStore,
  options: { id: string; name: string; device: (driveKey: string) => Promise<Uint8Array> },
): Promise<AlbumResult<Drive>> {
  const { id, name, device } = options;
  try {
    // Without a namespace, `openOwn()` is the device's own identity drive.
    const drive = await drives.openOwn(`folder/${id}`);
    await drive.put(DRIVE_PATH_DEVICE, await device(drive.key));
    await drive.put(DRIVE_PATH_FOLDER, Buffer.from(JSON.stringify({ version: 1, name })));
    return [null, drive];
  } catch (thrown: unknown) {
    return [{ kind: "write-failed", message: errText(thrown) }, null];
  }
}

/** The name the Admin's `/folder.json` gives an album this device joined, when
 * it differs from the one shown. An Admin's own album never takes a name from a drive. */
export async function albumNameUpdate(
  folderDrive: Drive,
  options: { role: Role; current: string; log: AlbumLog },
): Promise<string | undefined> {
  const { role, current, log } = options;
  if (role === "creator") return undefined;
  const name = parseFolderName(await readRecord(folderDrive, { path: DRIVE_PATH_FOLDER, log }));
  if (name === "" || name === current) return undefined;
  return name;
}

export type AlbumSummarySource = {
  record: {
    id: string;
    name: string;
    role: Role;
    pending?: boolean;
    shareKey: string;
    createdAt: number;
    invite?: { code: string; owner?: string };
    offerOwed?: OwedOffers;
    invited?: string[];
    invitedRoles?: Record<string, "reader" | "member">;
    earlier?: Array<{ key: string; name: string }>;
    notice?: FolderNotice;
  };
  selfDrive: { key: string };
  memberDrives: ReadonlyMap<string, unknown>;
  /** People the Admin accepted as Viewers, by key. */
  viewers: Readonly<Record<string, unknown>>;
};

/** What the album list shows for one album. `ownIdentity` names the Admin of
 * an album whose invite has no owner (this device's own). */
export function albumSummary(
  album: AlbumSummarySource,
  options: { ownIdentity: string },
): FolderSummary {
  const { record, selfDrive, memberDrives, viewers } = album;
  const role = record.role;
  // A pending reader reports the drive it asked to be enrolled with.
  const driveKey = role !== "reader" || record.pending ? selfDrive.key : "";
  // Everyone who sees the album: the Admin, this device, the live Collaborators
  // and the Viewers, each counted once on every phone.
  const earlier = new Set((record.earlier ?? []).map((e) => e.key));
  const people = new Set([record.shareKey, selfDrive.key, ...Object.keys(viewers)]);
  for (const key of memberDrives.keys()) if (!earlier.has(key)) people.add(key);
  const memberCount = people.size;
  const waitingFor =
    role === "creator"
      ? Object.entries(liveOwed(record.offerOwed, Date.now()))
          .sort((a, b) => a[1] - b[1])
          .map(([identity]) => identity)
      : [];
  const owed = new Set(waitingFor);
  const invitedFriends: InvitedFriend[] =
    role === "creator"
      ? [...waitingFor, ...(record.invited ?? []).filter((identity) => !owed.has(identity))].map(
          (identity) => ({ identity, role: record.invitedRoles?.[identity] ?? "member" }),
        )
      : [];
  return {
    id: record.id,
    name: record.name,
    role,
    pending: Boolean(record.pending),
    shareKey: record.shareKey,
    driveKey,
    members: memberCount,
    addedAt: record.createdAt,
    ...(record.notice ? { notice: record.notice } : {}),
    ...(waitingFor.length > 0 ? { waitingFor } : {}),
    ...(invitedFriends.length > 0 ? { invitedFriends } : {}),
    ...(record.invite
      ? {
          invite: {
            code: record.invite.code,
            owner: record.invite.owner ?? options.ownIdentity,
          },
        }
      : {}),
  };
}

/** Admin only: takes `memberKey` out of the album's registry. The drive itself
 * refuses the write on any other device. */
export async function removeAlbumMember(
  folderDrive: Drive,
  options: { memberKey: string; log: AlbumLog },
): Promise<AlbumResult<RegistryFile>> {
  const { memberKey, log } = options;
  const registry = parseRegistry(await readRecord(folderDrive, { path: DRIVE_PATH_MEMBERS, log }));
  if (!registry.members[memberKey]) {
    return [{ kind: "no-such-member", message: "No such member" }, null];
  }
  delete registry.members[memberKey];
  try {
    await folderDrive.put(DRIVE_PATH_MEMBERS, Buffer.from(JSON.stringify(registry)));
  } catch (thrown: unknown) {
    return [{ kind: "write-failed", message: errText(thrown) }, null];
  }
  return [null, registry];
}

export type AlbumPorts = { drives: DriveStore; log: AlbumLog; openTimeoutMs: number };

/** What an album this device started takes on when it moves to a new key. */
export type RotatedAlbum = {
  shareKey: string;
  driveKey: string;
  invite: { code: string };
  earlier: Array<{ key: string; name: string }>;
  notice: { kind: "newKey" };
  rotatedAt: number;
};

/** Moves an album this device started to a new drive (saved state 1 to 2):
 * copies its own photos, keeps the old members' drives as read-only sources and
 * their tombstones, and names the album. Nothing is returned until every write
 * succeeded, so a failure leaves the record as it was. */
export async function rotateAlbum(
  ports: AlbumPorts,
  options: {
    record: { id: string; name: string; shareKey: string };
    /** The identity drive. An album from before #195 lives on it; it is never released. */
    ownDrive: Drive;
    device: (driveKey: string) => Promise<Uint8Array>;
    inviteCode: string;
    now: number;
  },
): Promise<AlbumResult<RotatedAlbum>> {
  const { drives, log, openTimeoutMs } = ports;
  const { record, ownDrive, device, inviteCode, now } = options;
  const legacy = record.shareKey === ownDrive.key;
  let old: Drive | null = null;
  let fresh: Drive | null = null;
  try {
    if (legacy) {
      old = ownDrive;
    } else {
      const [openErr, opened] = await drives.open(record.shareKey, { timeoutMs: openTimeoutMs });
      if (openErr) return [{ kind: "rotate-failed", message: openErr.message }, null];
      old = opened;
    }
    const target = await drives.openOwn(`album/${record.id}`);
    fresh = target;
    await copyAlbumEntries(old, target);
    const registry = parseRegistry(await readRecord(old, { path: DRIVE_PATH_MEMBERS, log }));
    const earlier = Object.values(registry.members)
      .filter((m) => m.key !== target.key)
      .map((m) => ({ key: m.key, name: m.name }));
    const keys = new Set(earlier.map((e) => e.key));
    const removed = Object.fromEntries(
      Object.entries(parseRemoved(await readRecord(old, { path: DRIVE_PATH_REMOVED, log }))).filter(
        ([id]) => keys.has(id.split(":")[0]),
      ),
    );
    await target.put(DRIVE_PATH_DEVICE, await device(target.key));
    await target.put(
      DRIVE_PATH_FOLDER,
      Buffer.from(JSON.stringify({ version: 1, name: record.name })),
    );
    await target.put(DRIVE_PATH_REMOVED, Buffer.from(JSON.stringify({ version: 1, removed })));
    return [
      null,
      {
        shareKey: target.key,
        driveKey: target.key,
        invite: { code: inviteCode },
        earlier,
        notice: { kind: "newKey" },
        rotatedAt: now,
      },
    ];
  } catch (thrown: unknown) {
    return [{ kind: "rotate-failed", message: errText(thrown) }, null];
  } finally {
    try {
      if (old && !legacy) await drives.release(old);
    } catch {
      // already closed
    }
    try {
      if (fresh) await drives.release(fresh);
    } catch {
      // already closed
    }
  }
}
