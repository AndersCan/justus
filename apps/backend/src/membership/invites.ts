/**
 * Invites from both sides: asking through a link, the Admin's reply, offering an
 * album to a friend's phone, taking that offer and turning a link off, over the
 * drive port and the answer channel. photo-store keeps the saved state, topics,
 * connections and notifications.
 */
import type { Drive } from "../ports/drive-store";
import {
  DEFAULT_ASK_ALBUM,
  DEFAULT_ASK_OWNER,
  isHexKey,
  parseRequestsFile,
  peerName,
  type RequestsFile,
} from "./records";

const DRIVE_PATH_REQUESTS = "/requests.json";
/** Same cap as membership/join's MAX_PEER_JSON_BYTES. */
const MAX_RECORD_BYTES = 1024 * 1024;

export type InviteLog = (
  event: string,
  fields?: Record<string, string | number | boolean | undefined>,
) => void;

export type InviteError =
  | { kind: "write-failed"; message: string }
  | { kind: "refused"; message: string }
  | { kind: "unreachable"; message: string };
/** The repo's error tuple (ADR 0002 decision 8). */
export type InviteResult<T> = [InviteError, null] | [null, T];

function short(hex: string): string {
  return hex.slice(0, 8);
}

function errText(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}

async function readText(
  drive: Drive,
  options: { path: string; log: InviteLog },
): Promise<string | null> {
  const { path, log } = options;
  try {
    return (await drive.readSmall(path, MAX_RECORD_BYTES)) ?? null;
  } catch (thrown: unknown) {
    log("error", { where: "drive.read", drive: short(drive.key), path, err: errText(thrown) });
    return null;
  }
}

export type AskCheck<A> =
  | { kind: "invalid" }
  | { kind: "have-album" }
  | { kind: "known"; ask: A }
  | { kind: "new"; code: string; owner: string };

/** Whether a link can be asked through: both keys hex, not an album this phone
 * already holds (its own included), and not asked before. Keys are lowercased. */
export function checkAsk<A extends { code: string }>(
  input: { code: unknown; owner: unknown },
  held: { folders: ReadonlyArray<{ invite?: { code: string } }>; asks: readonly A[] },
): AskCheck<A> {
  const code = typeof input.code === "string" ? input.code.toLowerCase() : "";
  const owner = typeof input.owner === "string" ? input.owner.toLowerCase() : "";
  if (!isHexKey(code) || !isHexKey(owner)) return { kind: "invalid" };
  if (held.folders.some((f) => f.invite?.code === code)) return { kind: "have-album" };
  const known = held.asks.find((a) => a.code === code);
  if (known) return { kind: "known", ask: known };
  return { kind: "new", code, owner };
}

export type InviteAsk = {
  code: string;
  owner: string;
  albumName: string;
  ownerName: string;
  askedAt: number;
  status: "waiting";
};

/** Writes this phone's ask to its own outbox (the identity drive's
 * `/requests.json`) under `invite:<code>`: the code and the ask drive's key, never
 * an album key. Other entries stay. Names the link carried are clipped. */
export async function fileInviteAsk(
  identityDrive: Drive,
  options: {
    askDriveKey: string;
    code: string;
    owner: string;
    albumName: unknown;
    ownerName: unknown;
    requesterName: string;
    now: number;
    log: InviteLog;
  },
): Promise<InviteResult<InviteAsk>> {
  const { askDriveKey, code, owner, requesterName, now, log } = options;
  try {
    const text = await readText(identityDrive, { path: DRIVE_PATH_REQUESTS, log });
    const file: RequestsFile = (text && parseRequestsFile(text)) || { version: 1, requests: {} };
    file.requests[`invite:${code}`] = {
      requesterKey: askDriveKey,
      requesterName,
      invite: code,
      requestedAt: now,
    };
    await identityDrive.put(DRIVE_PATH_REQUESTS, Buffer.from(JSON.stringify(file)));
    return [
      null,
      {
        code,
        owner,
        albumName: peerName(options.albumName, DEFAULT_ASK_ALBUM),
        ownerName: peerName(options.ownerName, DEFAULT_ASK_OWNER),
        askedAt: now,
        status: "waiting",
      },
    ];
  } catch (thrown: unknown) {
    return [{ kind: "write-failed", message: errText(thrown) }, null];
  }
}

export type Reply =
  /** Final: the joiner is told no, and asking again changes nothing. */
  | { kind: "decline-ask"; identity: string }
  /** Hidden for this session only; a plain request has no answer to record. */
  | { kind: "decline" }
  | { kind: "already-enrolled" }
  /** Seat the requester; `identity` (an ask) is told once the seat is saved. */
  | { kind: "accept"; identity?: string };

/** The Admin's reply to one request. `askedBy` is the identity behind the
 * request when it came through this album's live invite. */
export function replyTo(
  request: { askedBy?: string; enrolled: boolean },
  options: { approve: boolean },
): Reply {
  if (!options.approve) {
    return request.askedBy
      ? { kind: "decline-ask", identity: request.askedBy }
      : { kind: "decline" };
  }
  if (request.enrolled) return { kind: "already-enrolled" };
  return request.askedBy ? { kind: "accept", identity: request.askedBy } : { kind: "accept" };
}
