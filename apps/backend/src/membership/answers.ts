/**
 * The answer channel's arriving side and the Admin's owed answers: proving
 * which identity a connection is, what each joiner is owed, and what an
 * arriving answer means. photo-store keeps the saved state, connections,
 * topics, timers and notifications.
 */
import type { Drive, OpenResult } from "../ports/drive-store";
import type { PeerNetwork } from "../ports/peer-network";
import { parseAnswer, parseDeviceSwarmKey, type Answer } from "./records";

const DRIVE_PATH_DEVICE = "/device.json";
/** Same cap as membership/join's MAX_PEER_JSON_BYTES. */
const MAX_RECORD_BYTES = 1024 * 1024;

export type AnswerLog = (
  event: string,
  fields?: Record<string, string | number | boolean | undefined>,
) => void;

function short(hex: string): string {
  return hex.slice(0, 8);
}

function errText(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}

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
  shareKey: string;
  invite?: { code: string };
  retiredInvites?: readonly string[];
  answers?: Readonly<Record<string, "accepted" | "declined">>;
};

/** Every answer owed to `identity`: per creator album with an invite and an
 * answer for it, one message per code (current code first, then retired codes
 * in order). Albums in the order given. */
export function answersOwed(albums: Iterable<OwingAlbum>, identity: string): Answer[] {
  const owed: Answer[] = [];
  for (const album of albums) {
    const answer = album.answers?.[identity];
    if (album.role !== "creator" || !album.invite || !answer) continue;
    for (const code of [album.invite.code, ...(album.retiredInvites ?? [])]) {
      owed.push(
        answer === "accepted" ? { code, answer, shareKey: album.shareKey } : { code, answer },
      );
    }
  }
  return owed;
}

export type DeliveryPorts = {
  /** Open connections: the identity each claims and the codes already sent on it (mutated by deliverOwed). */
  connections(): Array<{ conn: number; identity: string | undefined; sent: Set<string> }>;
  provenIdentity(conn: number): Promise<string | undefined>;
  sendAnswer: PeerNetwork["sendAnswer"];
};

/** Sends what `owed()` returns on every connection proven to be `identity`,
 * once per code per connection. `owed` is read after each proof, so an answer
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
      if (codes.has(message.code)) continue;
      codes.add(message.code);
      if (ports.sendAnswer(conn, message) === true) {
        log("answer.sent", { conn, code: short(message.code), answer: message.answer });
        sent++;
      } else {
        codes.delete(message.code);
        retry = true;
      }
    }
  }
  return { sent, retry };
}

export type ArrivalPorts = { provenIdentity(conn: number): Promise<string | undefined> };

export type AnswerArrival =
  | {
      kind: "ignored";
      reason: "version" | "malformed" | "no-waiting-ask" | "unverified" | "settled";
    }
  | { kind: "declined"; code: string }
  | { kind: "accepted"; code: string; shareKey: string };

/** What an answer arriving on `conn` settles. Only the ask's owner, proven, settles it. */
export async function arrivingAnswer(
  ports: ArrivalPorts,
  options: {
    conn: number;
    value: unknown;
    refused: boolean;
    asks: () => ReadonlyArray<{ code: string; owner: string; status: string }>;
  },
): Promise<AnswerArrival> {
  const { conn, value, refused, asks } = options;
  if (refused) return { kind: "ignored", reason: "version" };
  const answer = parseAnswer(value);
  if (!answer) return { kind: "ignored", reason: "malformed" };
  const waiting = (code: string) => asks().find((a) => a.code === code && a.status === "waiting");
  const ask = waiting(answer.code);
  if (!ask) return { kind: "ignored", reason: "no-waiting-ask" };
  if ((await ports.provenIdentity(conn)) !== ask.owner) {
    return { kind: "ignored", reason: "unverified" };
  }
  if (!waiting(answer.code)) return { kind: "ignored", reason: "settled" };
  if (answer.answer === "declined") return { kind: "declined", code: answer.code };
  return { kind: "accepted", code: answer.code, shareKey: answer.shareKey };
}
