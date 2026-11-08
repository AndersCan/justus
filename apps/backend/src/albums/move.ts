/**
 * Moves an album to new drives when the Admin removes someone: a new own drive
 * with the Admin's photos, every remaining person's old drive kept as a source
 * in `/earlier.json`. Writes nothing to the old drive. Ports and records only.
 */
import type { Drive, DriveStore } from "../ports/drive-store";
import {
  MAX_EARLIER_ENTRIES,
  parseRemoved,
  type EarlierEntry,
  type EarlierFile,
  type RegistryFile,
  type ViewersFile,
} from "../membership/records";
import { copyAlbumEntries } from "../rotate-album";
import type { AlbumLog, AlbumPorts, AlbumResult } from "./albums";

const MAX_RECORD_BYTES = 1024 * 1024;

/** How many earlier drives one album lists. */
export const MAX_EARLIER = MAX_EARLIER_ENTRIES;

/** What an album this device started takes on when it moves because someone was removed. */
export type MovedAlbum = {
  shareKey: string;
  driveKey: string;
  invite: { code: string };
  earlier: EarlierEntry[];
  moves: number;
};

function errText(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}

async function readText(drive: Drive, path: string, log: AlbumLog): Promise<string | null> {
  try {
    return (await drive.readSmall(path, MAX_RECORD_BYTES)) ?? null;
  } catch (thrown: unknown) {
    log("error", { where: "drive.read", path, err: errText(thrown) });
    return null;
  }
}

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
  },
): Promise<AlbumResult<MovedAlbum>> {
  const { drives, log } = ports;
  const { record, oldDrive, remaining, removedKey, device, inviteCode } = options;
  const moves = (record.moves ?? 0) + 1;
  let fresh: Drive | null = null;
  try {
    const target = await drives.openOwn(`folder/${record.id}/m${moves}`);
    fresh = target;
    await copyAlbumEntries(oldDrive, target);

    const sources = new Map<string, EarlierEntry>();
    for (const e of record.earlier ?? []) sources.set(e.key, { key: e.key, name: e.name });
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
      Object.entries(parseRemoved(await readText(oldDrive, "/removed.json", log))).filter(([id]) =>
        keys.has(id.split(":")[0]),
      ),
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
      const bytes = await from.readBytes(entry.path);
      if (!bytes) throw new Error(`follow: cannot read ${entry.path}`);
      if (have.get(entry.path) === bytes.byteLength) continue;
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
