/**
 * What an album's own drives hold, and the drive work of creating, naming,
 * listing and removing a member, over the drive port. photo-store keeps the
 * saved records, swarm topics, invites and notifications.
 */
import type { Drive, DriveStore } from "../ports/drive-store";
import type { FolderNotice, FolderSummary, Role } from "@justus/core";
import { parseFolderName, parseRegistry, type RegistryFile } from "../membership/records";

const DRIVE_PATH_DEVICE = "/device.json";
const DRIVE_PATH_FOLDER = "/folder.json";
const DRIVE_PATH_MEMBERS = "/members.json";
/** Same cap as membership/join's MAX_PEER_JSON_BYTES: peers control these bytes. */
const MAX_RECORD_BYTES = 1024 * 1024;

export type AlbumLog = (
  event: string,
  fields?: Record<string, string | number | boolean | undefined>,
) => void;

export type AlbumError =
  | { kind: "write-failed"; message: string }
  | { kind: "no-such-member"; message: string };
/** The repo's error tuple (ADR 0002 decision 8). */
export type AlbumResult<T> = [AlbumError, null] | [null, T];

function short(hex: string): string {
  return hex.slice(0, 8);
}

function errText(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}

async function readText(
  drive: Drive,
  options: { path: string; log: AlbumLog },
): Promise<string | null> {
  const { path, log } = options;
  try {
    return (await drive.readSmall(path, MAX_RECORD_BYTES)) ?? null;
  } catch (thrown: unknown) {
    log("error", { where: "drive.read", drive: short(drive.key), path, err: errText(thrown) });
    return null;
  }
}

/** Opens the new album's own drive (namespace `folder/<id>`, never the identity
 * drive) and writes who made it and its name. */
export async function createAlbumDrive(
  drives: DriveStore,
  options: { id: string; name: string; device: Uint8Array },
): Promise<AlbumResult<Drive>> {
  const { id, name, device } = options;
  try {
    // Without a namespace, `openOwn()` is the device's own identity drive.
    const drive = await drives.openOwn(`folder/${id}`);
    await drive.put(DRIVE_PATH_DEVICE, device);
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
  const name = parseFolderName(await readText(folderDrive, { path: DRIVE_PATH_FOLDER, log }));
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
    earlier?: Array<{ key: string; name: string }>;
    notice?: FolderNotice;
  };
  selfDrive: { key: string };
  memberDrives: ReadonlyMap<string, unknown>;
};

/** What the album list shows for one album. `ownIdentity` names the Admin of
 * an album whose invite has no owner (this device's own). */
export function albumSummary(
  album: AlbumSummarySource,
  options: { ownIdentity: string },
): FolderSummary {
  const { record, selfDrive, memberDrives } = album;
  const role = record.role;
  // A pending reader reports the drive it asked to be enrolled with.
  const driveKey = role !== "reader" || record.pending ? selfDrive.key : "";
  // `memberDrives` is a Map: the other enrolled members' drives (use `.size`).
  const earlier = (record.earlier ?? []).filter((e) => memberDrives.has(e.key)).length;
  const memberCount =
    role === "creator" || role === "member" ? memberDrives.size - earlier + 1 : memberDrives.size;
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
  const registry = parseRegistry(await readText(folderDrive, { path: DRIVE_PATH_MEMBERS, log }));
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
