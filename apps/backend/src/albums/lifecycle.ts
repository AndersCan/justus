/**
 * The drive work of deleting an album for everyone: the delete note, reading it
 * back from a peer's drive, and clearing an album's photos. photo-store keeps
 * the saved records, the actors and the drives they run on.
 *
 * LIMITATION(#376): a phone hears the delete only while the Admin's phone can
 * still be reached. If the Admin uninstalls before an away member comes back,
 * that member keeps the album.
 * LIMITATION(#377): a drive's history keeps old file names and dates after
 * `del`; only the bytes are gone. There is no fix short of a new drive.
 */
import { DEFAULT_ASK_OWNER, isTextJSON, peerName } from "../membership/records";
import type { Drive } from "../ports/drive-store";

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

/** Whether the Admin's member list (as text) shows this phone gone: the list must exist and not list `memberKey`. */
export function adminDroppedYou(registryText: string | null, memberKey: string): boolean {
  if (registryText === null) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(registryText);
  } catch {
    return false;
  }
  if (!isTextJSON(parsed) || !isTextJSON(parsed.members) || Array.isArray(parsed.members)) {
    return false;
  }
  return !(memberKey in parsed.members);
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
