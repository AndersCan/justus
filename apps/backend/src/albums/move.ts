/**
 * Moves an album to new drives when the Admin removes someone: a new own drive
 * with the Admin's photos, every remaining person's old drive kept as a source
 * in `/earlier.json`. Writes nothing to the old drive; `clearMovedPhotos` deletes this
 * device's copy of its photo bytes once the move is saved. Ports and records only.
 */
import type { Drive, DriveEntry, DriveStore } from "../ports/drive-store";
import {
  MAX_EARLIER_ENTRIES,
  parseRemoved,
  type EarlierEntry,
  type EarlierFile,
  type RegistryFile,
  type ViewersFile,
} from "../membership/records";
import { copyFormer, copyHeld } from "../photos/holders";
import { copyAlbumEntries } from "../rotate-album";
import type { AlbumPorts, AlbumResult } from "./albums";
import { errText } from "../p2p-log.ts";
import { readRecord } from "../membership/join.ts";
import { PHOTO_DIRS } from "./lifecycle";

/** How many earlier drives one album lists. */
export const MAX_EARLIER = MAX_EARLIER_ENTRIES;

/** What an album this device started takes on when it moves because someone was removed. */
export type MovedAlbum = {
  shareKey: string;
  driveKey: string;
  invite: { code: string };
  earlier: EarlierEntry[];
  moves: number;
  /** The drives of the Admins before this phone, after the move: each a copy on a drive of its own, or the original when the copy was incomplete. */
  earlierAdmins: string[];
};

/** How long a missing earlier-Admin photo is waited for before the original stays a source. */
const EARLIER_ADMIN_COPY_MS = 5_000;

export async function moveAlbum(
  ports: Pick<AlbumPorts, "log"> & { drives: DriveStore },
  options: {
    record: { id: string; name: string; moves?: number; earlier?: EarlierEntry[] };
    /** The album's current own drive. Only read. */
    oldDrive: Drive;
    /** Collaborators and Viewers who stay, the removed person already out of both. */
    remaining: { members: RegistryFile["members"]; viewers: ViewersFile["viewers"] };
    removedKey: string;
    device: (driveKey: string) => Promise<Uint8Array>;
    inviteCode: string;
    /** Drives of the Admins before this phone, whose photos move to a drive of their own. */
    earlierAdmins?: { drive: Drive }[];
  },
): Promise<AlbumResult<MovedAlbum>> {
  const { drives, log } = ports;
  const { record, oldDrive, remaining, removedKey, device, inviteCode } = options;
  const pastAdmins = options.earlierAdmins ?? [];
  const moves = (record.moves ?? 0) + 1;
  let fresh: Drive | null = null;
  try {
    const target = await drives.openOwn(`folder/${record.id}/m${moves}`);
    fresh = target;
    await copyAlbumEntries(oldDrive, target);
    await copyHeld(oldDrive, target);
    await copyFormer(oldDrive, target);

    const removedAll = parseRemoved(await readRecord(oldDrive, { path: "/removed.json", log }));
    const adminKeys: string[] = [];
    const copies = new Map<string, string>();
    for (const [i, past] of pastAdmins.entries()) {
      const prefix = `${past.drive.key}:`;
      const removedIds = new Set(
        Object.keys(removedAll)
          .filter((k) => k.startsWith(prefix))
          .map((k) => k.slice(prefix.length)),
      );
      const copy = await drives.openOwn(`folder/${record.id}/m${moves}/a${i}`);
      try {
        const [copyErr] = await copyEarlierAdmin(past.drive, copy, removedIds);
        if (copyErr) {
          adminKeys.push(past.drive.key);
          continue;
        }
        adminKeys.push(copy.key);
        copies.set(past.drive.key, copy.key);
      } finally {
        await drives.release(copy).catch(() => {});
      }
    }

    const sources = new Map<string, EarlierEntry>();
    for (const e of record.earlier ?? []) {
      const key = copies.get(e.key) ?? e.key;
      sources.set(key, { key, name: e.name });
    }
    for (const m of Object.values(remaining.members)) {
      sources.set(m.key, { key: m.key, name: m.name });
    }
    for (const v of Object.values(remaining.viewers)) {
      if (v.keptVersion === undefined) continue;
      sources.set(v.key, { key: v.key, name: v.name, keptVersion: v.keptVersion });
    }
    for (const gone of [removedKey, oldDrive.key, target.key]) sources.delete(gone);
    const earlier = [...sources.values()].slice(0, MAX_EARLIER);

    const keys = new Set(earlier.map((e) => e.key));
    const removed = Object.fromEntries(
      Object.entries(removedAll).filter(([id]) => keys.has(id.split(":")[0])),
    );
    const earlierFile: EarlierFile = { version: 1, earlier };
    await target.put("/device.json", await device(target.key));
    await target.put(
      "/folder.json",
      Buffer.from(JSON.stringify({ version: 1, name: record.name })),
    );
    await target.put("/removed.json", Buffer.from(JSON.stringify({ version: 1, removed })));
    await target.put("/viewers.json", Buffer.from(JSON.stringify({ version: 1, viewers: {} })));
    // The Admin is never listed in their own registry.
    await target.put("/members.json", Buffer.from(JSON.stringify({ version: 1, members: {} })));
    await target.put("/earlier.json", Buffer.from(JSON.stringify(earlierFile)));
    return [
      null,
      {
        shareKey: target.key,
        driveKey: target.key,
        invite: { code: inviteCode },
        earlier,
        moves,
        earlierAdmins: adminKeys,
      },
    ];
  } catch (thrown: unknown) {
    return [{ kind: "rotate-failed", message: errText(thrown) }, null];
  } finally {
    try {
      if (fresh) await drives.release(fresh);
    } catch {
      // already closed
    }
  }
}

/**
 * Copies an earlier Admin's photos and thumbnails, except the album's removed ones, onto `to`.
 * Each file is downloaded first, since a read of a missing block waits forever. The first file
 * that is not here makes the copy incomplete.
 */
export async function copyEarlierAdmin(
  from: Drive,
  to: Drive,
  removedIds: ReadonlySet<string>,
): Promise<AlbumResult<true>> {
  try {
    for (const dir of ["/photos", "/thumbs"]) {
      for await (const entry of from.list(dir)) {
        if (removedIds.has(idOfPath(entry.path))) continue;
        const found = await from.download(entry.path, { timeoutMs: EARLIER_ADMIN_COPY_MS });
        if (found !== "here") return [{ kind: "copy-incomplete", message: entry.path }, null];
        const bytes = await from.readBytes(entry.path);
        if (!bytes) return [{ kind: "copy-incomplete", message: entry.path }, null];
        await to.put(entry.path, bytes, { metadata: entry.metadata });
      }
    }
    return [null, true];
  } catch (thrown: unknown) {
    return [{ kind: "copy-incomplete", message: errText(thrown) }, null];
  }
}

/**
 * Deletes this device's copy of the bytes of the photos and thumbnails on `from`, an album
 * drive the album moved away from. Entries and every other file stay readable. With `copiedTo`,
 * only files it holds too (same path and size, same sha256 when both carry one). Lists only
 * what is on this device, never waiting for a peer. Safe to run again.
 */
export async function clearMovedPhotos(
  from: Drive,
  options?: { copiedTo?: Drive },
): Promise<AlbumResult<number>> {
  let cleared = 0;
  try {
    for (const dir of PHOTO_DIRS) {
      const kept = new Map<string, DriveEntry>();
      if (options?.copiedTo) {
        for await (const entry of options.copiedTo.list(dir, { wait: false })) {
          kept.set(entry.path, entry);
        }
      }
      const paths: string[] = [];
      for await (const entry of from.list(dir, { wait: false })) {
        const copy = kept.get(entry.path);
        const wantHash = entry.metadata.sha256;
        const sameHash = wantHash === undefined || copy?.metadata.sha256 === wantHash;
        if (options?.copiedTo && (copy?.size !== entry.size || !sameHash)) continue;
        paths.push(entry.path);
      }
      for (const path of paths) {
        await from.clear(path);
        cleared++;
      }
    }
    return [null, cleared];
  } catch (thrown: unknown) {
    return [{ kind: "clear-failed", message: errText(thrown) }, null];
  }
}

/** The id a photo path carries: `/photos/<id>.<ext>` or `/thumbs/<id>.jpg`. */
function idOfPath(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/** A Collaborator's phone moving with the album: copies its own photos and
 * thumbnails onto its new drive, leaving out the ones the album removed (their
 * ids in `removedIds`). Existing paths of the same size are skipped, so a run
 * cut short can be repeated. */
export async function copyOwnEntries(
  from: Drive,
  to: Drive,
  removedIds: ReadonlySet<string>,
): Promise<number> {
  let copied = 0;
  for (const dir of ["/photos", "/thumbs"]) {
    const have = new Map<string, number>();
    for await (const entry of to.list(dir)) have.set(entry.path, entry.size);
    for await (const entry of from.list(dir)) {
      if (removedIds.has(idOfPath(entry.path))) continue;
      if (have.get(entry.path) === entry.size) continue;
      const bytes = await from.readBytes(entry.path);
      if (!bytes) throw new Error(`follow: cannot read ${entry.path}`);
      await to.put(entry.path, bytes, { metadata: entry.metadata });
      if (dir === "/photos") copied++;
    }
  }
  return copied;
}

/** How many photos `drive` shows once the album's removed ones are left out. */
export async function countShownPhotos(
  drive: Drive,
  removedIds: ReadonlySet<string>,
): Promise<number> {
  let shown = 0;
  for await (const entry of drive.list("/photos")) {
    if (!removedIds.has(idOfPath(entry.path))) shown++;
  }
  return shown;
}
