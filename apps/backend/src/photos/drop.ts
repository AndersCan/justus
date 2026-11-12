import type { Drive } from "../ports/drive-store";
import { parseSpoolName } from "../spool-name";
import { DRIVE_PATH_PHOTOS, DRIVE_PATH_THUMBS } from "./gallery";

const THUMB_EXT = "thumb.jpg";

export type DropInput = {
  /** Drives other phones write, live, to sweep: never this phone's own, never a kept (`openAt`) copy. */
  others: ReadonlyArray<{ key: string; drive: Drive }>;
  selfKey: string;
  /** This phone's own album drive: photos the Admin tombstoned are cleared and deleted from it. */
  selfDrive: Drive;
  /** Parsed `/removed.json` of the folder drive: "<driveKey>:<id>" -> entry. */
  removed: Readonly<Record<string, unknown>>;
  /** Base names in the album's spool dir; [] when it does not exist. */
  spoolNames: readonly string[];
  /** Drops a photo's spool files and routes. */
  forget(driveKey: string, id: string, ext: string): void;
  /** Deletes one spool file by base name (a leftover `.tmp`). */
  removeSpool(name: string): void;
  log: (event: string, fields: Record<string, unknown>) => void;
  timeoutMs: number;
};

export type DropResult = { dropped: number };

function message(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}

/**
 * Drops what other phones deleted: the stored bytes of files a drive's latest version no longer
 * has, the bytes of photos the Admin tombstoned, and the matching cached copies.
 * Safe to repeat. Never rejects.
 */
export async function dropDeleted(input: DropInput): Promise<DropResult> {
  const { others, selfKey, removed, spoolNames, log, timeoutMs } = input;
  let dropped = 0;
  try {
    const byKey = new Map(others.map((o) => [o.key, o.drive]));
    const have = new Map<string, ReadonlySet<string>>();
    for (const { key, drive } of others) {
      try {
        const [e, r] = await drive.clearDeleted({ timeoutMs });
        if (e) log("error", { where: "dropDeleted", drive: key.slice(0, 8), err: e.message });
        else have.set(key, r.paths);
      } catch (thrown: unknown) {
        log("error", { where: "dropDeleted", drive: key.slice(0, 8), err: message(thrown) });
      }
    }

    // The Admin's tombstones: the entry still exists on the adder's drive.
    for (const [rk, drive] of byKey) {
      const ids: string[] = [];
      for (const tombKey of Object.keys(removed)) {
        if (tombKey.startsWith(`${rk}:`)) ids.push(tombKey.slice(rk.length + 1));
      }
      if (ids.length === 0) continue;
      try {
        for await (const entry of drive.list(DRIVE_PATH_PHOTOS)) {
          const base = entry.path.slice(DRIVE_PATH_PHOTOS.length + 1);
          const id = ids.find((i) => base === i || base.startsWith(`${i}.`));
          if (id === undefined) continue;
          await drive.clear(entry.path);
          await drive.clear(`${DRIVE_PATH_THUMBS}/${id}.jpg`).catch(() => {});
        }
      } catch (thrown: unknown) {
        log("error", { where: "dropDeleted", drive: rk.slice(0, 8), err: message(thrown) });
      }
    }

    // The Admin deleted this phone's own photo: it leaves the own drive too.
    const ownIds: string[] = [];
    for (const tombKey of Object.keys(removed)) {
      if (tombKey.startsWith(`${selfKey}:`)) ownIds.push(tombKey.slice(selfKey.length + 1));
    }
    if (ownIds.length > 0) {
      try {
        const entries: string[] = [];
        for await (const entry of input.selfDrive.list(DRIVE_PATH_PHOTOS)) entries.push(entry.path);
        for (const entryPath of entries) {
          const base = entryPath.slice(DRIVE_PATH_PHOTOS.length + 1);
          const id = ownIds.find((i) => base === i || base.startsWith(`${i}.`));
          if (id === undefined) continue;
          const thumb = `${DRIVE_PATH_THUMBS}/${id}.jpg`;
          await input.selfDrive.clear(entryPath);
          await input.selfDrive.del(entryPath);
          await input.selfDrive.clear(thumb).catch(() => {});
          await input.selfDrive.del(thumb);
          input.forget(selfKey, id, base.slice(id.length));
          dropped += 1;
        }
      } catch (thrown: unknown) {
        log("error", { where: "dropDeleted", drive: selfKey.slice(0, 8), err: message(thrown) });
      }
    }

    for (const name of spoolNames) {
      const parsed = parseSpoolName(name);
      if (!parsed) continue;
      const { driveKey, id, ext } = parsed;
      if (driveKey === selfKey) continue;
      const tomb = removed[`${driveKey}:${id}`] !== undefined;
      const paths = have.get(driveKey);
      const drivePath =
        ext === THUMB_EXT ? `${DRIVE_PATH_THUMBS}/${id}.jpg` : `${DRIVE_PATH_PHOTOS}/${id}${ext}`;
      const gone = paths !== undefined && !paths.has(drivePath);
      if (!tomb && !gone) continue;
      try {
        if (name.endsWith(".tmp")) input.removeSpool(name);
        else input.forget(driveKey, id, ext === THUMB_EXT ? "" : ext);
        dropped += 1;
      } catch (thrown: unknown) {
        log("error", { where: "dropDeleted", photo: id, err: message(thrown) });
      }
    }
    log("photos.dropped", { files: dropped, drives: have.size });
  } catch (thrown: unknown) {
    log("error", { where: "dropDeleted", err: message(thrown) });
  }
  return { dropped };
}
