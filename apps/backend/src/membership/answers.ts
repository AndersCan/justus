/**
 * The answer channel's arriving side and the Admin's owed answers: proving
 * which identity a connection is, what each joiner is owed, and what an
 * arriving answer means. photo-store keeps the saved state, connections,
 * topics, timers and notifications.
 */
import type { LinkOffWhy } from "@justus/core";
import type { Drive, IdentityProof, OpenResult } from "../ports/drive-store";
import type { PeerNetwork } from "../ports/peer-network";
import {
  chainReaches,
  inLinkTime,
  parseAnswer,
  parseDeviceSwarmKey,
  type Answer,
  type HandoverProof,
  type LinkTime,
} from "./records";
import { errText, short, type P2pLog } from "../p2p-log.ts";

const DRIVE_PATH_DEVICE = "/device.json";
/** Same cap as membership/join's MAX_PEER_JSON_BYTES. */
const MAX_RECORD_BYTES = 1024 * 1024;

export type AnswerLog = P2pLog;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T | undefined> =>
  Promise.race([p, sleep(ms).then(() => undefined)]);

/** One connection as proveIdentity sees it, read fresh on every attempt. */
export type ClaimedConn = {
  /** Identity drive key the greeting claimed; unproven. */
  identity: string | undefined;
  /** The connection's noise key. */
  peerKey: string | undefined;
  verified: boolean;
};

/** The identity behind a connection once its claimed identity drive's
 * `/device.json` names the connection's peer key; undefined when it never does
 * within `attempts`, or `conn()` returns undefined (gone, or the app closed). */
export async function proveIdentity(
  openIdentity: (identity: string) => Promise<OpenResult<Drive>>,
  options: {
    connId: number;
    conn: () => ClaimedConn | undefined;
    ownIdentity: string;
    attempts: number;
    waitMs: number;
    log: AnswerLog;
  },
): Promise<string | undefined> {
  const { connId, conn, ownIdentity, attempts, waitMs, log } = options;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const c = conn();
    if (!c) return undefined;
    if (c.verified) return c.identity;
    if (c.identity && c.peerKey && c.identity !== ownIdentity) {
      try {
        const [openError, drive] = await openIdentity(c.identity);
        if (openError) {
          log("error", { where: "verifiedIdentity", conn: connId, err: errText(openError) });
        } else {
          // `update()` first: the local copy may hold the key of the peer's last boot.
          await withTimeout(drive.update(), 2_000);
          const text = await withTimeout(
            drive.readSmall(DRIVE_PATH_DEVICE, MAX_RECORD_BYTES),
            5_000,
          );
          if (text && parseDeviceSwarmKey(text) === c.peerKey) return c.identity;
        }
      } catch (thrown: unknown) {
        log("error", { where: "verifiedIdentity", conn: connId, err: errText(thrown) });
      }
    }
    await sleep(waitMs);
  }
  return undefined;
}

/** An album as answersOwed reads it (structural; photo-store passes FolderRecord). */
export type OwingAlbum = {
  role?: string;
  name: string;
  shareKey: string;
  /** Drives that held the lists, first Admin's first; longer than one once the album was handed on. */
  adminChain?: readonly string[];
  invite?: { code: string; links?: readonly LinkTime[] };
  /** Identities with an open friend invite: never turned away by link times. */
  invited?: readonly string[];
  retiredInvites?: readonly string[];
  /** Why a retired code was retired, when known (creator only). */
  retiredWhy?: Readonly<Record<string, "turnedOff" | "replaced">>;
  answers?: Readonly<Record<string, "accepted" | "declined">>;
  /** When the ask a decline answered was made, per identity. */
  declinedAsks?: Readonly<Record<string, number>>;
  /** Friend invites open, and asks with an answer tapped, when a Remove retired their code: identity -> code. Never turned away. */
  heldAsks?: Readonly<Record<string, string>>;
  /** Discovery keys of the keys this album had before it moved, newest first. */
  movedFrom?: readonly string[];
  /** Per invite code, the proofs that handed it on to this phone's identity (a new Admin only). */
  handoverChains?: Readonly<Record<string, readonly HandoverProof[]>>;
};

/** `opens`: the ask's entry in the asker's outbox is sealed so this phone can open it. */
export type AskedCode = { code: string; requestedAt: number; opens?: boolean };

/** `owed` with a "handedOver" first for each code that needs one, and nothing else for that
 * code: an `accepted` is never used up on a connection before the asker re-points. */
export function handedOverFirst(
  albums: Iterable<OwingAlbum>,
  asked: readonly AskedCode[],
  owed: readonly Answer[],
): Answer[] {
  const handedOver = handedOverOwed(albums, asked);
  const codes = new Set(handedOver.map((a) => a.code));
  return [...handedOver, ...owed.filter((a) => !codes.has(a.code))];
}

/** For each code in `asked` that this new Admin holds a chain for and whose ask does not
 * open here: a "handedOver", so the asker re-points and seals the ask again. */
export function handedOverOwed(
  albums: Iterable<OwingAlbum>,
  asked: readonly AskedCode[],
): Answer[] {
  const owed: Answer[] = [];
  for (const album of albums) {
    if (album.role !== "creator") continue;
    for (const a of asked) {
      const chain = album.handoverChains?.[a.code];
      if (!chain || chain.length === 0 || a.opens === true) continue;
      if (owed.some((o) => o.code === a.code)) continue;
      owed.push({ code: a.code, answer: "handedOver", chain: [...chain] });
    }
  }
  return owed;
}

/** Every answer owed to `identity`: per creator album with an invite and an
 * answer for it, one message per code (current code first, then retired codes
 * in order). Then, for each code in `asked` that this album turned off and no
 * saved answer settles, a "linkOff". Albums in the order given. */
export function answersOwed(
  albums: Iterable<OwingAlbum>,
  identity: string,
  asked: readonly AskedCode[] = [],
): Answer[] {
  const owed: Answer[] = [];
  for (const album of albums) {
    if (album.role !== "creator" || !album.invite) continue;
    const answer = album.answers?.[identity];
    const askedAt = album.declinedAsks?.[identity];
    if (answer) {
      for (const code of [album.invite.code, ...(album.retiredInvites ?? [])]) {
        if (answer === "accepted") {
          owed.push({
            code,
            answer,
            shareKey: album.shareKey,
            ...(album.movedFrom?.length ? { movedFrom: [...album.movedFrom] } : {}),
            ...(album.adminChain && album.adminChain.length > 1
              ? { adminDrive: album.adminChain[album.adminChain.length - 1] }
              : {}),
          });
        } else owed.push(askedAt === undefined ? { code, answer } : { code, answer, askedAt });
      }
    }
    for (const a of asked) {
      if (album.heldAsks?.[identity] === a.code) continue;
      const retired = album.retiredInvites?.includes(a.code) ?? false;
      const late =
        a.code === album.invite.code &&
        !album.invited?.includes(identity) &&
        !inLinkTime(album.invite.links, a.requestedAt);
      if (!retired && !late) continue;
      if (settles(answer, askedAt, a.requestedAt)) continue;
      const why = retired ? album.retiredWhy?.[a.code] : "expired";
      owed.push({
        code: a.code,
        answer: "linkOff",
        askedAt: a.requestedAt,
        ...(why ? { why } : {}),
      });
    }
  }
  return owed;
}

/** Same rule as join.ts answerClosesRequest; duplicated because use-case modules don't import siblings. */
function settles(
  answer: "accepted" | "declined" | undefined,
  declinedAt: number | undefined,
  requestedAt: number,
): boolean {
  return (
    answer === "accepted" ||
    (answer === "declined" && (declinedAt === undefined || requestedAt <= declinedAt))
  );
}

/** A "received" for each ask in `asked` that went through a current code of a creator
 * album and still waits on the Admin: the album's name and `ownerName`, so the asker's
 * screens show the Admin's words, never the link's. Albums and asks in the order given. */
export function receivedOwed(
  albums: Iterable<OwingAlbum>,
  identity: string,
  asked: readonly AskedCode[],
  ownerName: string,
): Answer[] {
  const owed: Answer[] = [];
  for (const album of albums) {
    if (album.role !== "creator" || !album.invite) continue;
    for (const a of asked) {
      if (a.code !== album.invite.code) continue;
      const late =
        !album.invited?.includes(identity) && !inLinkTime(album.invite.links, a.requestedAt);
      if (late) continue;
      if (settles(album.answers?.[identity], album.declinedAsks?.[identity], a.requestedAt))
        continue;
      owed.push({
        code: a.code,
        answer: "received",
        askedAt: a.requestedAt,
        albumName: album.name,
        // The owner's name the asker saw was the earlier Admin's.
        ownerName: album.handoverChains?.[a.code] ? "" : ownerName,
      });
    }
  }
  return owed;
}

/** A "linkOff" for each code in `asked` that belongs to an album this phone deleted. */
export function deletedAlbumAnswers(
  deletedCodes: ReadonlySet<string>,
  asked: readonly AskedCode[],
): Answer[] {
  return asked
    .filter((a) => deletedCodes.has(a.code))
    .map((a) => ({
      code: a.code,
      answer: "linkOff",
      askedAt: a.requestedAt,
      why: "albumDeleted",
    }));
}

export type DeliveryPorts = {
  /** Open connections: the identity each claims and the answers already sent on it (mutated by deliverOwed). */
  connections(): Array<{ conn: number; identity: string | undefined; sent: Set<string> }>;
  provenIdentity(conn: number): Promise<string | undefined>;
  sendAnswer: PeerNetwork["sendAnswer"];
};

/** Forgets that answers for `codes` were sent on this connection, so the next
 * deliverOwed sends whatever is owed now. Call when an identity's answer changes. */
export function forgetSent(sent: Set<string>, codes: readonly string[]): void {
  for (const key of [...sent]) {
    if (codes.some((code) => key.startsWith(`${code}:`))) sent.delete(key);
  }
}

/** Sends what `owed()` returns on every connection proven to be `identity`,
 * once per answer per connection, until forgetSent clears it. `owed` is read after each proof, so an answer
 * taken back meanwhile is not sent. `retry` is true when the channel refused a send. */
export async function deliverOwed(
  ports: DeliveryPorts,
  options: { identity: string; owed: () => Answer[]; log: AnswerLog },
): Promise<{ sent: number; retry: boolean }> {
  const { identity, owed, log } = options;
  let sent = 0;
  let retry = false;
  if (owed().length === 0) return { sent, retry };
  for (const { conn, identity: claimed, sent: codes } of ports.connections()) {
    if (claimed !== identity) continue;
    if ((await ports.provenIdentity(conn)) !== identity) {
      log("answer.unverified", { conn, identity: short(identity) });
      continue;
    }
    for (const message of owed()) {
      const key = `${message.code}:${message.answer}:${message.answer === "accepted" || message.answer === "handedOver" ? "" : (message.askedAt ?? "")}`;
      if (codes.has(key)) continue;
      codes.add(key);
      if (ports.sendAnswer(conn, message) === true) {
        log("answer.sent", { conn, code: short(message.code), answer: message.answer });
        sent++;
      } else {
        codes.delete(key);
        retry = true;
      }
    }
  }
  return { sent, retry };
}

export type ArrivalPorts = {
  provenIdentity(conn: number): Promise<string | undefined>;
  verify(proof: IdentityProof): boolean;
};

export type AnswerArrival =
  | {
      kind: "ignored";
      reason: "version" | "malformed" | "no-waiting-ask" | "unverified" | "settled" | "stale";
    }
  | { kind: "declined"; code: string }
  | { kind: "linkOff"; code: string; why?: LinkOffWhy }
  | { kind: "received"; code: string; albumName: string; ownerName: string }
  | { kind: "accepted"; code: string; shareKey: string; movedFrom: string[]; adminDrive?: string }
  | { kind: "handedOver"; code: string; owner: string };

/** What an answer arriving on `conn` settles. Only the ask's owner, proven, settles it. */
export async function arrivingAnswer(
  ports: ArrivalPorts,
  options: {
    conn: number;
    value: unknown;
    refused: boolean;
    asks: () => ReadonlyArray<{ code: string; owner: string; status: string; askedAt: number }>;
  },
): Promise<AnswerArrival> {
  const { conn, value, refused, asks } = options;
  if (refused) return { kind: "ignored", reason: "version" };
  const answer = parseAnswer(value);
  if (!answer) return { kind: "ignored", reason: "malformed" };
  const waiting = (code: string) => asks().find((a) => a.code === code && a.status === "waiting");
  const ask = waiting(answer.code);
  if (!ask) return { kind: "ignored", reason: "no-waiting-ask" };
  if (answer.answer === "handedOver") {
    const sender = await ports.provenIdentity(conn);
    const valid =
      sender !== undefined &&
      sender !== ask.owner &&
      chainReaches(answer.chain, {
        code: answer.code,
        from: ask.owner,
        to: sender,
        verify: (proof) => ports.verify(proof),
      });
    if (!valid) return { kind: "ignored", reason: "unverified" };
    if (!waiting(answer.code)) return { kind: "ignored", reason: "settled" };
    return { kind: "handedOver", code: answer.code, owner: sender };
  }
  const stale =
    answer.answer !== "accepted" && answer.askedAt !== undefined && answer.askedAt < ask.askedAt;
  if (stale) return { kind: "ignored", reason: "stale" };
  if ((await ports.provenIdentity(conn)) !== ask.owner) {
    return { kind: "ignored", reason: "unverified" };
  }
  if (!waiting(answer.code)) return { kind: "ignored", reason: "settled" };
  if (answer.answer === "declined") return { kind: "declined", code: answer.code };
  if (answer.answer === "linkOff")
    return { kind: "linkOff", code: answer.code, ...(answer.why ? { why: answer.why } : {}) };
  if (answer.answer === "received") {
    return {
      kind: "received",
      code: answer.code,
      albumName: answer.albumName,
      ownerName: answer.ownerName,
    };
  }
  return {
    kind: "accepted",
    code: answer.code,
    shareKey: answer.shareKey,
    movedFrom: answer.movedFrom ?? [],
    ...(answer.adminDrive ? { adminDrive: answer.adminDrive } : {}),
  };
}
