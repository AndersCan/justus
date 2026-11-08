/**
 * The removed note: `/removed-people.json` on an album's old drive lists the
 * drive keys of people the Admin removed while that drive was the album's.
 * A removed phone that finds its own key there turns the album read-only.
 */
import { isHexKey, isTextJSON } from "../membership/records";
import type { Drive } from "../ports/drive-store";
import type { LifecycleLog, NoteResult } from "./lifecycle";

export const DRIVE_PATH_REMOVED = "/removed-people.json";
/** Same cap as the other peer records: peers control these bytes. */
const MAX_NOTE_BYTES = 1024 * 1024;

function reasonOf(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}

/** The removed keys a note lists. Never throws; anything unreadable is "nobody removed". */
export function parseRemovedPeople(text: string | null): string[] {
  if (text === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!isTextJSON(parsed) || Array.isArray(parsed)) return [];
  if (parsed.version !== 1 || !Array.isArray(parsed.keys)) return [];
  const keys = new Set<string>();
  for (const key of parsed.keys) {
    if (typeof key === "string" && isHexKey(key)) keys.add(key.toLowerCase());
  }
  return [...keys];
}

/** The removed keys on the album's drive; `[]` when there is no note or it cannot be read yet. */
export async function readRemovedPeople(
  drive: Drive,
  options: { log: LifecycleLog; timeoutMs?: number },
): Promise<string[]> {
  try {
    const text = await drive.readSmall(
      DRIVE_PATH_REMOVED,
      MAX_NOTE_BYTES,
      options.timeoutMs === undefined ? undefined : { timeoutMs: options.timeoutMs },
    );
    return parseRemovedPeople(text ?? null);
  } catch (thrown: unknown) {
    options.log("error", { where: "readRemovedPeople", err: reasonOf(thrown) });
    return [];
  }
}

/** Admin: adds `key` to the note. Writes nothing when it is already listed. */
export async function addRemovedPerson(
  drive: Drive,
  options: { key: string; log: LifecycleLog },
): Promise<NoteResult> {
  try {
    const text = await drive.readSmall(DRIVE_PATH_REMOVED, MAX_NOTE_BYTES);
    const keys = parseRemovedPeople(text ?? null);
    const key = options.key.toLowerCase();
    if (keys.includes(key)) return [null, undefined];
    await drive.put(
      DRIVE_PATH_REMOVED,
      Buffer.from(JSON.stringify({ version: 1, keys: [...keys, key] })),
    );
    return [null, undefined];
  } catch (thrown: unknown) {
    options.log("error", { where: "addRemovedPerson", err: reasonOf(thrown) });
    return [{ reason: reasonOf(thrown) }, null];
  }
}
