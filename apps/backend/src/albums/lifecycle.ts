/**
 * The drive work of deleting an album for everyone: the delete note, reading it
 * back from a peer's drive, and clearing an album's photos. photo-store keeps
 * the saved records, the actors and the drives they run on.
 *
 * A member's phone that hears the delete keeps the note and serves it for
 * `PASS_ON_DELETE_MS`, so a member who was away hears it from any member who
 * heard it. One who meets nobody in that time keeps the album.
 * The Admin's delete leaves only the note and drops older versions
 * (`clearDeletedAlbum`); albums from before #195 keep their history.
 */
import { DEFAULT_ASK_OWNER, isTextJSON, peerName } from "../membership/records";
import type { Drive } from "../ports/drive-store";

/** A member's phone keeps and serves the Admin's delete note this long after hearing it. */
export const PASS_ON_DELETE_MS = 90 * 24 * 60 * 60 * 1000;

export const DRIVE_PATH_DELETED = "/deleted.json";
export const DRIVE_PATH_LEFT = "/left.json";
/** Same cap as the other peer records: peers control these bytes. */
const MAX_NOTE_BYTES = 1024 * 1024;
/** The directories of an album's drive that hold photo bytes. */
const PHOTO_DIRS = ["/photos", "/thumbs"];

export type LifecycleLog = (
  event: string,
  fields?: Record<string, string | number | boolean | undefined>,
) => void;

/** The repo's error tuple: `[reason, null]` on failure. */
export type NoteResult = [{ reason: string }, null] | [null, void];

function reasonOf(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}

/** What a delete note says. A note of a version this phone does not know still counts as deleted. */
export function parseDeleteNote(text: string | null): { adminName: string } | undefined {
  if (text === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isTextJSON(parsed) || Array.isArray(parsed)) return undefined;
  return { adminName: peerName(parsed.adminName, DEFAULT_ASK_OWNER) };
}

/** Admin: writes `/deleted.json` into the album's own drive. */
export async function writeDeleteNote(
  drive: Drive,
  options: { adminName: string; at: number },
): Promise<NoteResult> {
  try {
    const note = { version: 1, adminName: options.adminName, at: options.at };
    await drive.put(DRIVE_PATH_DELETED, Buffer.from(JSON.stringify(note)));
    return [null, undefined];
  } catch (thrown: unknown) {
    return [{ reason: reasonOf(thrown) }, null];
  }
}

/** The delete note in the album's own drive, or undefined when there is none (or it cannot be read yet). */
export async function readDeleteNote(
  drive: Drive,
  options: { log: LifecycleLog; timeoutMs?: number },
): Promise<{ adminName: string } | undefined> {
  try {
    const text = await drive.readSmall(
      DRIVE_PATH_DELETED,
      MAX_NOTE_BYTES,
      options.timeoutMs === undefined ? undefined : { timeoutMs: options.timeoutMs },
    );
    return parseDeleteNote(text ?? null);
  } catch (thrown: unknown) {
    options.log("error", { where: "readDeleteNote", err: reasonOf(thrown) });
    return undefined;
  }
}

/** Member: writes `/left.json` into the member's own drive in the album. */
export async function writeLeftNote(drive: Drive, options: { at: number }): Promise<NoteResult> {
  try {
    const note = { version: 1, leftAt: options.at };
    await drive.put(DRIVE_PATH_LEFT, Buffer.from(JSON.stringify(note)));
    return [null, undefined];
  } catch (thrown: unknown) {
    return [{ reason: reasonOf(thrown) }, null];
  }
}

/** When a left note says the member left, or undefined for a missing or malformed note. */
export function parseLeftNote(text: string | null): { leftAt: number } | undefined {
  if (text === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isTextJSON(parsed) || Array.isArray(parsed)) return undefined;
  const { leftAt } = parsed;
  if (typeof leftAt !== "number" || !Number.isFinite(leftAt)) return undefined;
  return { leftAt };
}

/** A member's left note from their drive, or undefined when there is none (or it cannot be read yet). */
export async function readLeftNote(
  drive: Drive,
  options: { log: LifecycleLog; timeoutMs?: number },
): Promise<{ leftAt: number } | undefined> {
  try {
    const text = await drive.readSmall(
      DRIVE_PATH_LEFT,
      MAX_NOTE_BYTES,
      options.timeoutMs === undefined ? undefined : { timeoutMs: options.timeoutMs },
    );
    return parseLeftNote(text ?? null);
  } catch (thrown: unknown) {
    options.log("error", { where: "readLeftNote", err: reasonOf(thrown) });
    return undefined;
  }
}

/** Removes a leftover left note, as when the same drive joins the album again. Never rejects. */
export async function clearLeftNote(drive: Drive, options: { log: LifecycleLog }): Promise<void> {
  try {
    if ((await drive.readSmall(DRIVE_PATH_LEFT, MAX_NOTE_BYTES)) === undefined) return;
    await drive.del(DRIVE_PATH_LEFT);
  } catch (thrown: unknown) {
    options.log("error", { where: "clearLeftNote", err: reasonOf(thrown) });
  }
}

/** The people named in `list` of the Admin's list text, or null when the text is missing, not JSON, or has no such object. */
function namesIn(listText: string | null, list: "members" | "viewers"): object | null {
  if (listText === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(listText);
  } catch {
    return null;
  }
  if (!isTextJSON(parsed)) return null;
  const names = parsed[list];
  if (!isTextJSON(names) || Array.isArray(names)) return null;
  return names;
}

/** Whether the Admin's list (as text) shows this phone gone: the file must exist, `list` must be an object and not name `memberKey`. */
export function adminDroppedYou(
  listText: string | null,
  memberKey: string,
  list: "members" | "viewers" = "members",
): boolean {
  const names = namesIn(listText, list);
  return names !== null && !(memberKey in names);
}

/** Whether the Admin's list (as text) names this phone: the file must parse to a `list` object that holds `memberKey`. */
export function adminListsYou(
  listText: string | null,
  memberKey: string,
  list: "members" | "viewers",
): boolean {
  const names = namesIn(listText, list);
  return names !== null && memberKey in names;
}

/** Clears the bytes of every photo and thumbnail in `drive`, then deletes their entries. Safe to run twice. */
export async function deleteOwnPhotos(drive: Drive, options: { log: LifecycleLog }): Promise<void> {
  for (const dir of PHOTO_DIRS) {
    const paths: string[] = [];
    for await (const entry of drive.list(dir)) paths.push(entry.path);
    for (const path of paths) {
      try {
        await drive.clear(path);
        await drive.del(path);
      } catch (thrown: unknown) {
        options.log("error", { where: "deleteOwnPhotos", path, err: reasonOf(thrown) });
      }
    }
  }
}

/**
 * Admin, after the delete note is written: deletes every other file of the album's drive,
 * bytes first, and leaves the note as the drive's last write, so the drive drops every
 * older version of itself. Safe to run again, as at every start. Never rejects.
 */
export async function clearDeletedAlbum(
  drive: Drive,
  options: { log: LifecycleLog },
): Promise<void> {
  try {
    const paths: string[] = [];
    for await (const entry of drive.list("/")) {
      if (entry.path !== DRIVE_PATH_DELETED) paths.push(entry.path);
    }
    for (const path of paths) {
      try {
        await drive.clear(path);
        await drive.del(path);
      } catch (thrown: unknown) {
        options.log("error", { where: "clearDeletedAlbum", path, err: reasonOf(thrown) });
      }
    }
    const [error, kept] = await drive.keepOnly(DRIVE_PATH_DELETED);
    if (error) {
      options.log("error", { where: "clearDeletedAlbum", err: reasonOf(error) });
      return;
    }
    if (kept.olderVersionsCleared) return;
    const note = await drive.readSmall(DRIVE_PATH_DELETED, MAX_NOTE_BYTES);
    if (note === undefined) {
      options.log("error", { where: "clearDeletedAlbum", err: "delete note unreadable" });
      return;
    }
    await drive.put(DRIVE_PATH_DELETED, Buffer.from(note));
    const [again, second] = await drive.keepOnly(DRIVE_PATH_DELETED);
    if (again || !second.olderVersionsCleared) {
      options.log("error", { where: "clearDeletedAlbum", err: "older versions kept" });
    }
  } catch (thrown: unknown) {
    options.log("error", { where: "clearDeletedAlbum", err: reasonOf(thrown) });
  }
}

/** True once `isListed` says so, looking again up to `tries` times, `waitMs` apart: a phone's copy of the Admin's list can trail the Admin's accept. */
export async function listedWithin(options: {
  isListed: () => Promise<boolean>;
  tries: number;
  waitMs: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<boolean> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; attempt < options.tries; attempt++) {
    if (await options.isListed()) return true;
    if (attempt < options.tries - 1) await sleep(options.waitMs);
  }
  return false;
}
