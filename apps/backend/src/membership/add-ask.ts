/**
 * A Viewer's ask to add photos: `/add-photos-ask.json` on the Viewer's own
 * album drive. The Admin's phone already watches every Viewer's drive, so it
 * reads the ask from there.
 */
import { isTextJSON } from "./records";
import type { Drive } from "../ports/drive-store";

export const DRIVE_PATH_ADD_ASK = "/add-photos-ask.json";
const MAX_ASK_BYTES = 4096;

/** The repo's error tuple: `[reason, null]` on failure. */
export type AskResult = [{ reason: string }, null] | [null, undefined];

/** When the Viewer asked, or undefined for a missing or malformed file. */
export function parseAddAsk(text: string | null): { askedAt: number } | undefined {
  if (text === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isTextJSON(parsed) || Array.isArray(parsed)) return undefined;
  const { askedAt } = parsed;
  if (typeof askedAt !== "number" || !Number.isFinite(askedAt) || askedAt <= 0) return undefined;
  return { askedAt };
}

/** Viewer: writes the ask into the Viewer's own drive in the album. */
export async function writeAddAsk(drive: Drive, options: { at: number }): Promise<AskResult> {
  try {
    await drive.put(DRIVE_PATH_ADD_ASK, Buffer.from(JSON.stringify({ askedAt: options.at })));
    return [null, undefined];
  } catch (thrown: unknown) {
    return [{ reason: thrown instanceof Error ? thrown.message : String(thrown) }, null];
  }
}

/** A Viewer's ask from their drive, or undefined when there is none (or it cannot be read yet). Never rejects. */
export async function readAddAsk(drive: Drive): Promise<{ askedAt: number } | undefined> {
  try {
    const text = await drive.readSmall(DRIVE_PATH_ADD_ASK, MAX_ASK_BYTES, { timeoutMs: 2_000 });
    return parseAddAsk(text ?? null);
  } catch {
    return undefined;
  }
}
