/**
 * Invites from both sides: asking through a link, the Admin's reply, offering an
 * album to a friend's phone, taking that offer and turning a link off, over the
 * drive port and the answer channel. photo-store keeps the saved state, topics,
 * connections and notifications.
 */
import type { Drive } from "../ports/drive-store";
import type { PeerNetwork } from "../ports/peer-network";
import type { OfferSummary } from "@justus/core";
import {
  DEFAULT_ASK_ALBUM,
  DEFAULT_ASK_OWNER,
  isHexKey,
  parseRequestsFile,
  peerName,
  type ChannelMessage,
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
 * already holds (its own included), and not asked before or asked and declined. Keys are lowercased. */
export function checkAsk<A extends { code: string; status: string }>(
  input: { code: unknown; owner: unknown },
  held: { folders: ReadonlyArray<{ invite?: { code: string } }>; asks: readonly A[] },
): AskCheck<A> {
  const code = typeof input.code === "string" ? input.code.toLowerCase() : "";
  const owner = typeof input.owner === "string" ? input.owner.toLowerCase() : "";
  if (!isHexKey(code) || !isHexKey(owner)) return { kind: "invalid" };
  if (held.folders.some((f) => f.invite?.code === code)) return { kind: "have-album" };
  const known = held.asks.find((a) => a.code === code);
  if (known && known.status !== "declined") return { kind: "known", ask: known };
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

/** The saved record of a new ask: names the link carried are clipped. */
export function newInviteAsk(options: {
  code: string;
  owner: string;
  albumName: unknown;
  ownerName: unknown;
  now: number;
}): InviteAsk {
  return {
    code: options.code,
    owner: options.owner,
    albumName: peerName(options.albumName, DEFAULT_ASK_ALBUM),
    ownerName: peerName(options.ownerName, DEFAULT_ASK_OWNER),
    askedAt: options.now,
    status: "waiting",
  };
}

/** Writes this phone's ask to its own outbox (the identity drive's
 * `/requests.json`) under `invite:<code>`: the code and the ask drive's key
 * sealed to the Admin's phone, never in plain text and never an album key.
 * Other entries stay. */
export async function fileInviteAsk(
  identityDrive: Drive,
  options: {
    sealedKey: string;
    code: string;
    requesterName: string;
    requestedAt: number;
    log: InviteLog;
  },
): Promise<InviteResult<undefined>> {
  const { sealedKey, code, requesterName, requestedAt, log } = options;
  try {
    const text = await readText(identityDrive, { path: DRIVE_PATH_REQUESTS, log });
    const file: RequestsFile = (text && parseRequestsFile(text)) || { version: 1, requests: {} };
    file.requests[`invite:${code}`] = {
      sealedKey,
      requesterName,
      invite: code,
      requestedAt,
    };
    await identityDrive.put(DRIVE_PATH_REQUESTS, Buffer.from(JSON.stringify(file)));
    return [null, undefined];
  } catch (thrown: unknown) {
    return [{ kind: "write-failed", message: errText(thrown) }, null];
  }
}

export type Reply =
  /** The joiner is told no; a newer ask from them is a new request. */
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

/** What invites need from the answer channel. photo-store fills it from its
 * connections, `verifiedIdentity` and the peer network. */
export type InvitePorts = {
  /** Open connections and the identity each claims (unproven). */
  connections(): Array<{ conn: number; identity: string | undefined }>;
  /** The identity `conn` proved, or undefined when it did not within `timeoutMs`. */
  provenIdentity(conn: number, options: { timeoutMs: number }): Promise<string | undefined>;
  sendAnswer: PeerNetwork["sendAnswer"];
};

/** Sends `message` on every connection proven to be `identity`, one at a time.
 * Returns how many sends the channel took. */
export async function tellIdentity(
  ports: InvitePorts,
  options: { identity: string; message: ChannelMessage; timeoutMs: number },
): Promise<number> {
  const { identity, message, timeoutMs } = options;
  let sent = 0;
  for (const c of ports.connections()) {
    if (c.identity !== identity) continue;
    if ((await ports.provenIdentity(c.conn, { timeoutMs })) !== identity) continue;
    if (ports.sendAnswer(c.conn, message) === true) sent += 1;
  }
  return sent;
}

/** Offers an album to a friend's phone, resending every `resendMs`, until it
 * says it saw or refused the invite, the app closes, or `reachMs` passes. */
export async function offerAlbumTo(
  ports: InvitePorts,
  options: {
    identity: string;
    offer: { code: string; albumName: string; ownerName: string };
    reply: Promise<"seen" | "refused">;
    reachMs: number;
    resendMs: number;
    isClosed: () => boolean;
  },
): Promise<InviteResult<"seen">> {
  const { identity, offer, reply, resendMs, isClosed } = options;
  const deadline = Date.now() + options.reachMs;
  let got: "seen" | "refused" | undefined;
  void reply.then((r) => (got = r));
  while (!got && !isClosed() && Date.now() < deadline) {
    await tellIdentity(ports, {
      identity,
      message: {
        kind: "offer",
        code: offer.code,
        albumName: offer.albumName,
        ownerName: offer.ownerName,
      },
      timeoutMs: deadline - Date.now(),
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        reply,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, resendMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  if (got === "seen") return [null, "seen"];
  if (got === "refused")
    return [{ kind: "refused", message: "The friend's phone turned the invite down" }, null];
  return [{ kind: "unreachable", message: "The friend's phone did not answer" }, null];
}

export type OfferTake<A> =
  | { kind: "gone" }
  | { kind: "file-ask"; offer: OfferSummary }
  | { kind: "asked"; ask: A };

/** What taking a held invite needs: it is gone (taken back), it needs an ask
 * (none yet, or the last one was declined), or the ask already went out. */
export function offerToTake<A extends { code: string; status: string }>(
  held: { offers: readonly OfferSummary[]; asks: readonly A[] },
  wanted: { code: string; owner: string },
): OfferTake<A> {
  const offer = held.offers.find((o) => o.code === wanted.code && o.owner === wanted.owner);
  if (!offer) return { kind: "gone" };
  const ask = held.asks.find((a) => a.code === wanted.code);
  if (!ask || ask.status === "declined" || ask.status === "linkOff") {
    return { kind: "file-ask", offer };
  }
  return { kind: "asked", ask };
}

export type NewInvite = {
  invite: { code: string };
  /** The code turned off, when the album had one. */
  retired?: string;
  retiredInvites?: string[];
};

/** Turns an album's link off: every friend with an open invite is told it was
 * withdrawn, and the album gets `newCode`; the old code is kept so a joiner who
 * asked through it still gets an answer. Does not change `album`. */
export async function withdrawInvite(
  ports: InvitePorts,
  options: {
    album: {
      invite?: { code: string };
      invited?: readonly string[];
      /** identity -> the older code on that friend's card, when a Remove retired it. */
      heldAsks?: Readonly<Record<string, string>>;
      retiredInvites?: readonly string[];
    };
    newCode: string;
  },
): Promise<NewInvite> {
  const { album, newCode } = options;
  const old = album.invite?.code;
  if (!old) {
    return {
      invite: { code: newCode },
      retiredInvites: album.retiredInvites && [...album.retiredInvites],
    };
  }
  for (const identity of album.invited ?? []) {
    await tellIdentity(ports, {
      identity,
      message: { kind: "offerWithdrawn", code: album.heldAsks?.[identity] ?? old },
      timeoutMs: 2_000,
    });
  }
  return {
    invite: { code: newCode },
    retired: old,
    retiredInvites: [...(album.retiredInvites ?? []), old],
  };
}
