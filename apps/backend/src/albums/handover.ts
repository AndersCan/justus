/**
 * Handing an album to a new Admin (#824). The old Admin leaves `/admin.json` on
 * the drive that holds the lists; every phone follows it hop by hop and trusts
 * a hop only when the album's own lists and the next drive's identity agree.
 * Ports and records only.
 */
import type { Drive, IdentityProof, OpenResult } from "../ports/drive-store";
import {
  MAX_ADMIN_CHAIN,
  MAX_HANDOVER_ANSWERS,
  MAX_HANDOVER_CODES,
  isEnrolled,
  isHexKey,
  isTextJSON,
  parseAdminNote,
  parseProofChain,
  parseRegistry,
  peerName,
  verifiedDeviceIdentity,
  type AdminNote,
  type DeviceIdentity,
  type HandoverPackage,
  type HandoverProof,
  type LinkTime,
} from "../membership/records";
import { DRIVE_PATH_MEMBERS, MAX_PEER_JSON_BYTES } from "../membership/join.ts";
import { errText, type P2pLog } from "../p2p-log.ts";
import type { AlbumResult } from "./albums";

export const DRIVE_PATH_ADMIN = "/admin.json";

/** The six list files a new Admin's drive takes over, in digest order. `/members.json` is last on purpose. */
const LIST_PATHS = [
  "/viewers.json",
  "/folder.json",
  "/removed.json",
  "/earlier.json",
  "/former.json",
  DRIVE_PATH_MEMBERS,
] as const;

const READ_MS = 5_000;

async function readLists(drive: Drive): Promise<Array<string | undefined>> {
  const texts: Array<string | undefined> = [];
  for (const path of LIST_PATHS) {
    texts.push(await drive.readSmall(path, MAX_PEER_JSON_BYTES, { timeoutMs: READ_MS }));
  }
  return texts;
}

function digestOf(texts: ReadonlyArray<string | undefined>, hash: (text: string) => string) {
  return hash(texts.map((t) => `${(t ?? "").length}:${t ?? ""}`).join("\n"));
}

/** The `/members.json` text with `without` left out, as {@link takeAdminRecords} writes it. */
function membersWithout(text: string | undefined, without: string): string {
  const registry = parseRegistry(text ?? null);
  const members = Object.fromEntries(
    Object.entries(registry.members).filter(([, m]) => m.key !== without),
  );
  return JSON.stringify({ version: 1, members });
}

/** sha-256 (by `hash`) of the six list files' texts as read, a missing file as "". With `without`, the members are rewritten less that key, as {@link takeAdminRecords} writes them: the leaving Admin passes the next Admin's key to get the digest the reply must carry. */
export async function listsDigest(
  drive: Drive,
  hash: (text: string) => string,
  options: { without?: string } = {},
): Promise<string> {
  const texts = await readLists(drive);
  if (options.without !== undefined) {
    texts[LIST_PATHS.length - 1] = membersWithout(texts[LIST_PATHS.length - 1], options.without);
  }
  return digestOf(texts, hash);
}

/** Copies the six list files from the Admin's drive onto the next Admin's own drive, leaving `self` out of the members (an Admin is never in their own list). Writes `/members.json` last. Returns the digest of what was written, the same {@link listsDigest} gives for the next Admin's drive. */
export async function takeAdminRecords(
  from: Drive,
  to: Drive,
  options: { self: string; hash: (text: string) => string },
): Promise<AlbumResult<{ digest: string }>> {
  try {
    const texts = await readLists(from);
    for (let i = 0; i < LIST_PATHS.length - 1; i++) {
      const text = texts[i];
      if (text !== undefined) await to.put(LIST_PATHS[i], Buffer.from(text));
    }
    const membersText = membersWithout(texts[LIST_PATHS.length - 1], options.self);
    await to.put(DRIVE_PATH_MEMBERS, Buffer.from(membersText));
    const written = [...texts.slice(0, LIST_PATHS.length - 1), membersText];
    return [null, { digest: digestOf(written, options.hash) }];
  } catch (thrown: unknown) {
    return [{ kind: "write-failed", message: errText(thrown) }, null];
  }
}

export type FollowPorts = {
  open: (key: string) => Promise<OpenResult<Drive>>;
  /** Called for a drive `open` gave that is not taken as a hop. */
  release: (drive: Drive) => Promise<void>;
  verify: (proof: IdentityProof) => boolean;
  log: P2pLog;
};

/** Follows `/admin.json` from `from`. A hop is taken only when the next key is a Collaborator in the current lists, its `/device.json` verifies to the named identity, its `/members.json` reads, it is not in `chain` or already followed, and `chain` and the hops together stay under {@link MAX_ADMIN_CHAIN}. Stops at the first hop that fails; the caller tries again on the next change. `unsupported` is true when it stopped at a note of a newer version. The caller releases the hop drives. */
export async function followAdmin(
  ports: FollowPorts,
  options: { from: Drive; chain: readonly string[] },
): Promise<{ hops: Array<{ drive: Drive; next: AdminNote["next"] }>; unsupported: boolean }> {
  const hops: Array<{ drive: Drive; next: AdminNote["next"] }> = [];
  const seen = new Set(options.chain);
  let unsupported = false;
  let current = options.from;
  seen.add(current.key);
  while (options.chain.length + hops.length < MAX_ADMIN_CHAIN) {
    const note = parseAdminNote(
      await current.readSmall(DRIVE_PATH_ADMIN, MAX_PEER_JSON_BYTES, { timeoutMs: READ_MS }),
      () => {
        unsupported = true;
      },
    );
    if (!note || seen.has(note.next.key)) break;
    const listed = parseRegistry(
      (await current.readSmall(DRIVE_PATH_MEMBERS, MAX_PEER_JSON_BYTES, { timeoutMs: READ_MS })) ??
        null,
    );
    if (!isEnrolled(listed, note.next.key)) break;
    const [error, drive] = await ports.open(note.next.key);
    if (error) {
      ports.log("warn", { where: "followAdmin.open", err: error.message });
      break;
    }
    const device = verifiedDeviceIdentity(
      (await drive.readSmall("/device.json", MAX_PEER_JSON_BYTES, { timeoutMs: READ_MS })) ?? "",
      { driveKey: drive.key, verify: ports.verify },
    );
    const members = await drive.readSmall(DRIVE_PATH_MEMBERS, MAX_PEER_JSON_BYTES, {
      timeoutMs: READ_MS,
    });
    if (
      device.status !== "verified" ||
      device.identityKey !== note.next.identity ||
      members === undefined
    ) {
      await ports.release(drive);
      break;
    }
    hops.push({ drive, next: note.next });
    seen.add(drive.key);
    current = drive;
  }
  return { hops, unsupported };
}

/** What an Admin keeps while a handover is under way. */
export type SavedHandover = {
  to: { key: string; identity: string; name: string };
  at: number;
  written?: true;
  chains: Record<string, HandoverProof[]>;
};

/** A saved handover, or undefined when any part of it is malformed. */
export function parseSavedHandover(value: unknown): SavedHandover | undefined {
  if (!isTextJSON(value) || !isTextJSON(value.to) || !isTextJSON(value.chains)) return undefined;
  const { key, identity } = value.to;
  if (typeof key !== "string" || !isHexKey(key)) return undefined;
  if (typeof identity !== "string" || !isHexKey(identity)) return undefined;
  if (typeof value.at !== "number" || !Number.isFinite(value.at)) return undefined;
  const chains: Record<string, HandoverProof[]> = {};
  for (const [code, chain] of Object.entries(value.chains)) {
    const parsed = isHexKey(code) ? parseProofChain(chain) : undefined;
    if (!parsed) return undefined;
    chains[code] = parsed;
  }
  return {
    to: {
      key: key.toLowerCase(),
      identity: identity.toLowerCase(),
      name: peerName(value.to.name, "Unknown device"),
    },
    at: value.at,
    ...(value.written === true ? { written: true as const } : {}),
    chains,
  };
}

/** The invite codes an album hands over: its own first, then the retired ones. */
export function handoverCodes(record: {
  invite?: { code: string };
  retiredInvites?: readonly string[];
}): string[] {
  const codes = new Set<string>();
  if (record.invite) codes.add(record.invite.code.toLowerCase());
  for (const code of record.retiredInvites ?? []) codes.add(code.toLowerCase());
  return [...codes];
}

/** True when the album's invites and answers fit in one handover package. */
export function fitsPackage(record: {
  invite?: { code: string; links?: readonly LinkTime[] };
  retiredInvites?: readonly string[];
  answers?: Readonly<Record<string, string>>;
  declinedAsks?: Readonly<Record<string, number>>;
}): boolean {
  return (
    record.invite !== undefined &&
    handoverCodes(record).length <= MAX_HANDOVER_CODES &&
    (record.invite.links?.length ?? 0) <= MAX_HANDOVER_CODES &&
    Object.keys(record.answers ?? {}).length <= MAX_HANDOVER_ANSWERS &&
    Object.keys(record.declinedAsks ?? {}).length <= MAX_HANDOVER_ANSWERS
  );
}

/** The package the Admin sends: the album's invite state and one proof chain per code. Undefined when there is no invite or a code has no proof. */
export function buildHandoverPackage(
  record: {
    invite?: { code: string; links?: readonly LinkTime[] };
    retiredInvites?: readonly string[];
    retiredWhy?: Readonly<Record<string, "turnedOff" | "replaced">>;
    answers?: Readonly<Record<string, "accepted" | "declined">>;
    declinedAsks?: Readonly<Record<string, number>>;
  },
  options: { fromName: string; chains: Readonly<Record<string, HandoverProof[]>> },
): HandoverPackage | undefined {
  if (!record.invite) return undefined;
  const chains: Record<string, HandoverProof[]> = {};
  for (const code of handoverCodes(record)) {
    const chain = options.chains[code];
    if (!chain) return undefined;
    chains[code] = chain;
  }
  const retired = (record.retiredInvites ?? []).map((c) => c.toLowerCase());
  return {
    fromName: options.fromName,
    invite: {
      code: record.invite.code.toLowerCase(),
      ...(record.invite.links?.length ? { links: [...record.invite.links] } : {}),
    },
    ...(retired.length > 0 ? { retiredInvites: retired } : {}),
    ...(record.retiredWhy && Object.keys(record.retiredWhy).length > 0
      ? { retiredWhy: { ...record.retiredWhy } }
      : {}),
    ...(record.answers && Object.keys(record.answers).length > 0
      ? { answers: { ...record.answers } }
      : {}),
    ...(record.declinedAsks && Object.keys(record.declinedAsks).length > 0
      ? { declinedAsks: { ...record.declinedAsks } }
      : {}),
    chains,
  };
}

/** True when `device` (read from the album's lists drive) is a verified identity and `sender` is it. */
export function senderIsAdmin(device: DeviceIdentity, sender: string): boolean {
  return device.status === "verified" && device.identityKey === sender;
}

/** What the old Admin does with the next Admin's "ready" reply: `write` only from the chosen phone, when the lists and the next Admin's copy both carry the digest in the reply and the package is still the one sent. Otherwise why not. */
export function readyVerdict(input: {
  sender: string;
  chosen: string;
  digest: string;
  /** The digest of this phone's lists as the next Admin's copy would be written. */
  own: string;
  /** The digest of this phone's copy of the next Admin's drive; undefined when it never read. */
  theirs: string | undefined;
  /** The package that would be sent now, and the one last sent. */
  package: string | undefined;
  sent: string | undefined;
}): "write" | "sender" | "lists" | "copy" | "package" {
  if (input.sender !== input.chosen) return "sender";
  if (input.own !== input.digest) return "lists";
  if (input.theirs !== input.digest) return "copy";
  if (input.package === undefined || input.package !== input.sent) return "package";
  return "write";
}
