import type { JoinRequest, LinkOffWhy } from "@justus/core";
import type { IdentityProof } from "../ports/drive-store";
import { parseColor } from "./colors";

export type RegistryFile = {
  version: 1;
  members: Record<
    string,
    {
      key: string;
      name: string;
      addedAt: number;
      /** The person's colour seat, set by the Admin. */
      color?: number;
    }
  >;
};

/** People the Admin accepted as Viewers: they see every photo and add none.
 * Their own drive is never read, so nothing they write reaches the album. */
export type ViewersFile = {
  version: 1;
  viewers: Record<
    string,
    {
      key: string;
      name: string;
      addedAt: number;
      /** Set when a Collaborator became a Viewer: their drive is read up to this version. */
      keptVersion?: number;
      /** The person's colour seat, set by the Admin. */
      color?: number;
    }
  >;
};

/** An old drive of the album that stays a read source after a move. */
export type EarlierEntry = { key: string; name: string; keptVersion?: number };

/** `/earlier.json` on an album's drive: the drives the album moved away from. */
export type EarlierFile = { version: 1; earlier: EarlierEntry[] };

/** At most this many entries are read from `/earlier.json`. */
export const MAX_EARLIER_ENTRIES = 1000;

export type RemovedFile = {
  version: 1;
  removed: Record<string, { memberKey: string; removedAt: number }>;
};

/**
 * Join-request outbox on the REQUESTER's own single-writer drive, keyed by the
 * target folder's share key. `requests()` on the creator side reads this.
 */
export type RequestsFile = {
  version: 1;
  requests: Record<
    string,
    {
      /** Album-key requests only; an invite ask carries `sealedKey` instead. */
      requesterKey?: string;
      /** An invite ask's drive key, sealed to the Admin's phone. */
      sealedKey?: string;
      requesterName: string;
      /** Set by old-style requests, which name the album by its share key. */
      shareKey?: string;
      folderName?: string;
      /** Set by requests made through an invite code: the code, never a key. */
      invite?: string;
      requestedAt: number;
    }
  >;
};

/** Longest display name or album name taken from a peer's drive. */
export const MAX_PEER_NAME = 80;

export function isHexKey(key: string): boolean {
  return /^[0-9a-f]{64}$/i.test(key);
}

export function isTextJSON(value: unknown): value is { [k: string]: unknown } {
  return typeof value === "object" && value !== null;
}

/** A name read off a peer's drive: trimmed and clipped, else `fallback`. */
export function peerName(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const clean = value.trim().slice(0, MAX_PEER_NAME);
  return clean || fallback;
}

export function isEnrolled(registry: RegistryFile, key: string): boolean {
  return Object.values(registry.members).some((m) => m.key === key);
}

/** Keeps a valid `color` on each entry and drops an invalid one; the rest of the entry is as read. */
function withValidColors(members: RegistryFile["members"]): RegistryFile["members"] {
  return Object.fromEntries(
    Object.entries(members).map(([key, entry]) => {
      if (!isTextJSON(entry)) return [key, entry];
      const { color, ...rest } = entry as typeof entry & { color?: unknown };
      const valid = parseColor(color);
      return [key, valid === undefined ? rest : { ...rest, color: valid }];
    }),
  );
}

export function parseRegistry(text: string | null): RegistryFile {
  if (text === null) return { version: 1, members: {} };
  try {
    const parsed = JSON.parse(text) as { version?: unknown; members?: unknown };
    if (parsed.version === 1 && isTextJSON(parsed.members)) {
      return { version: 1, members: withValidColors(parsed.members as RegistryFile["members"]) };
    }
  } catch {
    // malformed
  }
  return { version: 1, members: {} };
}

/** The Viewers in a `/viewers.json`. Missing, malformed or wrong-version files
 * list no one; an entry whose key is not a hex key matching its record key, or
 * whose time is not a number, is dropped. */
export function parseViewers(text: string | null): ViewersFile {
  const empty: ViewersFile = { version: 1, viewers: {} };
  if (text === null) return empty;
  try {
    const parsed = JSON.parse(text) as { version?: unknown; viewers?: unknown };
    if (parsed.version !== 1 || !isTextJSON(parsed.viewers)) return empty;
    const viewers: ViewersFile["viewers"] = {};
    for (const [recordKey, raw] of Object.entries(parsed.viewers)) {
      if (!isTextJSON(raw) || !isHexKey(recordKey)) continue;
      if (raw.key !== recordKey) continue;
      if (typeof raw.addedAt !== "number" || !Number.isFinite(raw.addedAt)) continue;
      const keptVersion =
        typeof raw.keptVersion === "number" &&
        Number.isInteger(raw.keptVersion) &&
        raw.keptVersion >= 0
          ? raw.keptVersion
          : undefined;
      const color = parseColor(raw.color);
      viewers[recordKey] = {
        key: recordKey,
        name: peerName(raw.name, "New member"),
        addedAt: raw.addedAt,
        ...(keptVersion === undefined ? {} : { keptVersion }),
        ...(color === undefined ? {} : { color }),
      };
    }
    return { version: 1, viewers };
  } catch {
    return empty;
  }
}

/** The entries of an `/earlier.json`. Missing, malformed or unknown-version files
 * list none (an unknown version is reported through `onUnsupported`); entries
 * with a bad key are dropped, repeats keep the first, and at most
 * {@link MAX_EARLIER_ENTRIES} are read. */
export function parseEarlier(text: string | null, onUnsupported?: () => void): EarlierEntry[] {
  if (text === null) return [];
  try {
    const parsed = JSON.parse(text) as { version?: unknown; earlier?: unknown } | null;
    if (!isTextJSON(parsed)) return [];
    if (parsed.version !== 1) {
      onUnsupported?.();
      return [];
    }
    if (!Array.isArray(parsed.earlier)) return [];
    const out: EarlierEntry[] = [];
    const seen = new Set<string>();
    for (const raw of parsed.earlier.slice(0, MAX_EARLIER_ENTRIES) as unknown[]) {
      if (!isTextJSON(raw) || typeof raw.key !== "string" || !isHexKey(raw.key)) continue;
      const key = raw.key.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const keptVersion =
        typeof raw.keptVersion === "number" &&
        Number.isInteger(raw.keptVersion) &&
        raw.keptVersion >= 0
          ? raw.keptVersion
          : undefined;
      out.push({
        key,
        name: peerName(raw.name, "Unknown device"),
        ...(keptVersion === undefined ? {} : { keptVersion }),
      });
    }
    return out;
  } catch {
    return [];
  }
}

export function parseRemoved(text: string | null): RemovedFile["removed"] {
  if (text === null) return {};
  try {
    const parsed = JSON.parse(text) as { version?: unknown; removed?: unknown };
    if (parsed.version === 1 && isTextJSON(parsed.removed)) {
      return parsed.removed as RemovedFile["removed"];
    }
  } catch {
    // malformed
  }
  return {};
}

/** The album name in a `/folder.json`, or "" when missing or malformed. */
export function parseFolderName(text: string | null): string {
  if (text === null) return "";
  try {
    const parsed = JSON.parse(text) as { version?: unknown; name?: unknown };
    if (parsed.version === 1) return peerName(parsed.name, "");
  } catch {
    // malformed
  }
  return "";
}

/** The display name in a `/device.json`, or "Unknown device". */
export function parseDeviceName(text: string | null): string {
  const fallback = "Unknown device";
  if (!text) return fallback;
  try {
    const parsed = JSON.parse(text) as { name?: unknown };
    return peerName(parsed.name, fallback);
  } catch {
    return fallback;
  }
}

/** The swarm key in a `/device.json`, or undefined when missing, non-hex or malformed. */
export function parseDeviceSwarmKey(text: string): string | undefined {
  try {
    const parsed = JSON.parse(text) as { swarmKey?: unknown };
    if (typeof parsed.swarmKey === "string" && isHexKey(parsed.swarmKey)) return parsed.swarmKey;
  } catch {
    // not JSON
  }
  return undefined;
}

/** The field of an identity drive's `/device.json` that names its sealing key. */
export const DRIVE_FIELD_BOX = "boxKey";

/** The sealing key a `/device.json` publishes (64 hex, lowercased), or undefined. */
export function boxKeyOf(deviceText: string | null): string | undefined {
  if (deviceText === null) return undefined;
  try {
    const parsed = JSON.parse(deviceText) as { [DRIVE_FIELD_BOX]?: unknown };
    const key = parsed[DRIVE_FIELD_BOX];
    if (typeof key === "string" && isHexKey(key)) return key.toLowerCase();
  } catch {
    // not JSON
  }
  return undefined;
}

/** What an ask seals for the Admin: the ask drive's key, bound to who asks and through which code. */
export type SealedAsk = {
  v: 1;
  key: string;
  identity: string;
  invite: string;
  /** End time (ms) of the link the asker opened. Their claim, unchecked. */
  linkEnd?: number;
};

/** The end time of a link when it is a positive whole number, else undefined. */
export function validLinkEnd(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function sealedAskBytes(ask: Omit<SealedAsk, "v">): Uint8Array {
  return Buffer.from(JSON.stringify({ v: 1, ...ask }));
}

/** The ask in opened bytes, or undefined unless version 1 with three 64-hex fields. */
export function parseSealedAsk(bytes: Uint8Array): SealedAsk | undefined {
  try {
    const raw: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
    if (!isTextJSON(raw) || raw.v !== 1) return undefined;
    const { key, identity, invite } = raw;
    if (typeof key !== "string" || !isHexKey(key)) return undefined;
    if (typeof identity !== "string" || !isHexKey(identity)) return undefined;
    if (typeof invite !== "string" || !isHexKey(invite)) return undefined;
    const linkEnd = validLinkEnd(raw.linkEnd);
    return {
      v: 1,
      key: key.toLowerCase(),
      identity: identity.toLowerCase(),
      invite: invite.toLowerCase(),
      ...(linkEnd !== undefined && { linkEnd }),
    };
  } catch {
    return undefined;
  }
}

/** What a phone signs into the `/device.json` of a drive: the key of that drive. */
export function identityMessage(driveKey: string): Uint8Array {
  return Buffer.from(`justus-device/v1:${driveKey.toLowerCase()}`, "utf8");
}

export type DeviceIdentity =
  | { status: "verified"; identityKey: string }
  | { status: "unsigned" }
  | { status: "rejected" };

/** The identity in a `/device.json` read from the drive `driveKey`. Verified
 * (key lowercased) only when the identity signed this drive; unsigned when the
 * record names no identity or carries no proof (an older build); rejected when
 * the proof is malformed or does not verify. */
export function verifiedDeviceIdentity(
  text: string,
  options: { driveKey: string; verify: (proof: IdentityProof) => boolean },
): DeviceIdentity {
  try {
    const parsed = JSON.parse(text) as {
      identityKey?: unknown;
      identityPublicKey?: unknown;
      identitySig?: unknown;
    };
    const { identityKey, identityPublicKey, identitySig } = parsed;
    if (typeof identityKey !== "string" || !isHexKey(identityKey)) return { status: "unsigned" };
    if (identityPublicKey === undefined && identitySig === undefined) return { status: "unsigned" };
    if (
      typeof identityPublicKey !== "string" ||
      !isHexKey(identityPublicKey) ||
      typeof identitySig !== "string" ||
      !/^[0-9a-f]{128}$/i.test(identitySig)
    )
      return { status: "rejected" };
    const verified = options.verify({
      identityKey,
      publicKey: identityPublicKey,
      signature: identitySig,
      message: identityMessage(options.driveKey),
    });
    return verified
      ? { status: "verified", identityKey: identityKey.toLowerCase() }
      : { status: "rejected" };
  } catch {
    return { status: "unsigned" };
  }
}

/** The outbox in a `/requests.json`, or undefined when malformed or not version 1. */
export function parseRequestsFile(text: string): RequestsFile | undefined {
  try {
    const raw = JSON.parse(text) as { version?: unknown; requests?: unknown };
    if (raw.version !== 1 || !isTextJSON(raw.requests)) return undefined;
    return { version: 1, requests: raw.requests as RequestsFile["requests"] };
  } catch {
    return undefined;
  }
}

/** The join requests in a peer's outbox that target `shareKey`, or that were
 * made through `inviteCode`. Every field is the requester's own claim: shapes
 * are checked, never trusted. */
export function parseJoinRequests(
  text: string,
  target: { shareKey: string; folderId: string; folderName: string; inviteCode?: string },
): JoinRequest[] {
  const file = parseRequestsFile(text);
  if (!file) return [];
  const out: JoinRequest[] = [];
  for (const raw of Object.values(file.requests) as unknown[]) {
    if (!isTextJSON(raw)) continue;
    const req = raw as Record<string, unknown>;
    const viaInvite = target.inviteCode !== undefined && req.invite === target.inviteCode;
    if (req.shareKey !== target.shareKey && !viaInvite) continue;
    if (typeof req.requesterKey !== "string" || !isHexKey(req.requesterKey)) continue;
    out.push({
      requesterKey: req.requesterKey.toLowerCase(),
      requesterName: peerName(req.requesterName, "Unknown device"),
      folderId: target.folderId,
      folderName: peerName(req.folderName, target.folderName),
      shareKey: target.shareKey,
      requestedAt:
        typeof req.requestedAt === "number" && Number.isFinite(req.requestedAt)
          ? req.requestedAt
          : 0,
    });
  }
  return out;
}

/** The invite codes an outbox's requests were made through, with when. */
/** When one link the Admin made works: from its making to its end, ms since the epoch. */
export type LinkTime = {
  from: number;
  to: number;
  /** The name of the Admin who made the link; set only on links a new Admin inherited. */
  by?: string;
};

/** How far apart two phones' clocks may be. */
export const CLOCK_SLACK_MS = 10 * 60_000;

/** True when no link times are known (albums from before this), or `at` falls in one, with slack. */
export function inLinkTime(links: readonly LinkTime[] | undefined, at: number): boolean {
  if (!links || links.length === 0) return true;
  return links.some((l) => l.from - CLOCK_SLACK_MS <= at && at <= l.to + CLOCK_SLACK_MS);
}

export function invitesAsked(text: string): Array<{ code: string; requestedAt: number }> {
  const file = parseRequestsFile(text);
  if (!file) return [];
  const out: Array<{ code: string; requestedAt: number }> = [];
  for (const raw of Object.values(file.requests) as unknown[]) {
    if (!isTextJSON(raw)) continue;
    const req = raw as Record<string, unknown>;
    if (typeof req.invite !== "string" || !isHexKey(req.invite)) continue;
    if (typeof req.requestedAt !== "number" || !Number.isFinite(req.requestedAt)) continue;
    out.push({ code: req.invite, requestedAt: req.requestedAt });
  }
  return out;
}

/** What an Admin tells a joiner who asked through an invite code (`justus/answer/v1`). */
export type Answer =
  | {
      code: string;
      answer: "accepted";
      shareKey: string;
      movedFrom?: string[];
      /** The drive holding the lists when the album was handed on and `shareKey` is the first Admin's. */
      adminDrive?: string;
    }
  | { code: string; answer: "declined"; askedAt?: number }
  /** The Admin handed the album on: `chain` signs the asker's code over to the new Admin's identity. */
  | { code: string; answer: "handedOver"; chain: HandoverProof[] }
  /** The code no longer works for this ask; `why` says which, when known. */
  | { code: string; answer: "linkOff"; askedAt: number; why?: LinkOffWhy }
  /** The Admin's phone has this ask and it waits on the Admin: the names the asker's screens show. Never a key. */
  | { code: string; answer: "received"; askedAt: number; albumName: string; ownerName: string };

/** True for the four reasons a link can stop working. */
export function isLinkOffWhy(value: unknown): value is LinkOffWhy {
  return (
    value === "expired" || value === "turnedOff" || value === "replaced" || value === "albumDeleted"
  );
}

/** An answer off the wire, or undefined when it is malformed. */
export function parseAnswer(value: unknown): Answer | undefined {
  if (!isTextJSON(value)) return undefined;
  const {
    code,
    answer,
    shareKey,
    askedAt,
    movedFrom,
    adminDrive,
    why,
    albumName,
    ownerName,
    chain,
  } = value as {
    code?: unknown;
    chain?: unknown;
    answer?: unknown;
    shareKey?: unknown;
    askedAt?: unknown;
    movedFrom?: unknown;
    adminDrive?: unknown;
    why?: unknown;
    albumName?: unknown;
    ownerName?: unknown;
  };
  if (typeof code !== "string" || !isHexKey(code)) return undefined;
  if (answer === "handedOver") {
    const proofs = parseProofChain(chain);
    return proofs ? { code, answer, chain: proofs } : undefined;
  }
  if (answer === "received") {
    if (typeof askedAt !== "number" || !Number.isFinite(askedAt)) return undefined;
    if (typeof albumName !== "string" || typeof ownerName !== "string") return undefined;
    return {
      code,
      answer,
      askedAt,
      albumName: peerName(albumName, ""),
      ownerName: peerName(ownerName, ""),
    };
  }
  if (answer === "declined") {
    return typeof askedAt === "number" && Number.isFinite(askedAt)
      ? { code, answer, askedAt }
      : { code, answer };
  }
  if (answer === "linkOff") {
    if (typeof askedAt !== "number" || !Number.isFinite(askedAt)) return undefined;
    // An unknown reason (a future one) reads generic; the answer still stands.
    return isLinkOffWhy(why) ? { code, answer, askedAt, why } : { code, answer, askedAt };
  }
  if (answer === "accepted" && typeof shareKey === "string" && isHexKey(shareKey)) {
    const moved =
      Array.isArray(movedFrom) &&
      movedFrom.length > 0 &&
      movedFrom.every((k): k is string => typeof k === "string" && isHexKey(k));
    const handed =
      typeof adminDrive === "string" && isHexKey(adminDrive) && adminDrive !== shareKey
        ? { adminDrive }
        : {};
    return { code, answer, shareKey, ...(moved ? { movedFrom } : {}), ...handed };
  }
  return undefined;
}

/** Shown when a peer's invite names no album. */
export const DEFAULT_ASK_ALBUM = "this album";
/** Shown when a peer's invite names no Admin. */
export const DEFAULT_ASK_OWNER = "the Admin";

/** Messages between an Admin and a friend about an album invite. `code` is the album's invite code, never a key; `album` is an album key's discovery key. */
export type FriendMessage =
  | {
      kind: "offer";
      code: string;
      albumName: string;
      ownerName: string;
      /** Set when the Admin moved the album: `from` are the keys it had before. */
      move?: MoveOffer;
    }
  | { kind: "offerSeen"; code: string }
  | { kind: "offerRefused"; code: string }
  | { kind: "offerWithdrawn"; code: string }
  | { kind: "offerTaken"; code: string }
  /** A removed phone deleted its copy of the album whose old key has this discovery key. */
  | { kind: "copyDeleted"; album: string }
  /** The Admin's phone handled `copyDeleted` for `album`; the sender can stop telling it. */
  | { kind: "copyDeletedSeen"; album: string }
  /** Admin to the next Admin: the album's lists and links, to be confirmed with `handoverReady`. */
  | { kind: "handover"; album: string; digest: string; admin: HandoverPackage }
  /** Next Admin to the Admin: its copy of the lists matches `digest` and it holds every photo and preview that `photos` (see `photosDigest`) covers. */
  | { kind: "handoverReady"; album: string; digest: string; photos: string }
  /** Next Admin to the Admin: the next Admin's phone is the Admin now. */
  | { kind: "handoverDone"; album: string };

export type MoveOffer = { from: string[]; role: "member" | "reader" };

/** A `move` off the wire, or undefined when it is not fully valid. */
function parseMove(value: unknown): MoveOffer | undefined {
  if (!isTextJSON(value)) return undefined;
  const { from, role } = value;
  if (role !== "member" && role !== "reader") return undefined;
  if (!Array.isArray(from) || from.length < 1 || from.length > 10) return undefined;
  if (!from.every((k) => typeof k === "string" && isHexKey(k))) return undefined;
  return { from: from as string[], role };
}

/** Everything the answer channel carries. */
export type ChannelMessage = Answer | FriendMessage;

/** True for a value that belongs to {@link parseFriendMessage}, not {@link parseAnswer}. */
export function isFriendMessageShape(value: unknown): boolean {
  return isTextJSON(value) && typeof value.kind === "string";
}

/** A friend message off the wire, or undefined when it is malformed. */
export function parseFriendMessage(value: unknown): FriendMessage | undefined {
  if (!isTextJSON(value)) return undefined;
  const { kind, code, albumName, ownerName, album } = value;
  if (kind === "handover" || kind === "handoverReady" || kind === "handoverDone") {
    if (typeof album !== "string" || !isHexKey(album)) return undefined;
    const albumKey = album.toLowerCase();
    if (kind === "handoverDone") return { kind, album: albumKey };
    if (typeof value.digest !== "string" || !isHexKey(value.digest)) return undefined;
    const digest = value.digest.toLowerCase();
    if (kind === "handoverReady") {
      if (typeof value.photos !== "string" || !isHexKey(value.photos)) return undefined;
      return { kind, album: albumKey, digest, photos: value.photos.toLowerCase() };
    }
    const admin = parseHandoverPackage(value.admin);
    return admin ? { kind, album: albumKey, digest, admin } : undefined;
  }
  if (kind === "copyDeleted" || kind === "copyDeletedSeen") {
    return typeof album === "string" && isHexKey(album) ? { kind, album } : undefined;
  }
  if (typeof code !== "string" || !isHexKey(code)) return undefined;
  if (kind === "offer") {
    const base = {
      kind,
      code,
      albumName: peerName(albumName, DEFAULT_ASK_ALBUM),
      ownerName: peerName(ownerName, DEFAULT_ASK_OWNER),
    } as const;
    if (value.move === undefined) return base;
    // An offer with a bad move must not show as a plain invite.
    const move = parseMove(value.move);
    return move ? { ...base, move } : undefined;
  }
  if (
    kind === "offerSeen" ||
    kind === "offerRefused" ||
    kind === "offerWithdrawn" ||
    kind === "offerTaken"
  ) {
    return { kind, code };
  }
  return undefined;
}

/** What the Admin who hands an album on leaves at `/admin.json` of the drive that holds the lists. */
export type AdminNote = {
  version: 1;
  /** The next Admin's own album drive and identity drive, 64 hex each. */
  next: { key: string; identity: string; name: string };
  at: number;
};

/** The note in an `/admin.json` text. Missing or malformed reads as none; a version other than 1 reads as none and calls `onUnsupported`. */
export function parseAdminNote(
  text: string | null | undefined,
  onUnsupported?: () => void,
): AdminNote | undefined {
  if (text === null || text === undefined) return undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isTextJSON(parsed)) return undefined;
    if (parsed.version !== 1) {
      if (typeof parsed.version === "number" && parsed.version > 1) onUnsupported?.();
      return undefined;
    }
    const { next, at } = parsed;
    if (!isTextJSON(next) || typeof at !== "number" || !Number.isFinite(at)) return undefined;
    if (typeof next.key !== "string" || !isHexKey(next.key)) return undefined;
    if (typeof next.identity !== "string" || !isHexKey(next.identity)) return undefined;
    return {
      version: 1,
      next: {
        key: next.key.toLowerCase(),
        identity: next.identity.toLowerCase(),
        name: peerName(next.name, DEFAULT_ASK_OWNER),
      },
      at,
    };
  } catch {
    return undefined;
  }
}

/** One signature: identity `from` signed the code over to identity `to`. All hex, lowercased. */
export type HandoverProof = { from: string; to: string; publicKey: string; signature: string };

/** Longest run of Admins one album follows, and of links in one proof chain. */
export const MAX_ADMIN_CHAIN = 16;
/** Most invite links, retired codes and proof chains one handover carries. */
export const MAX_HANDOVER_CODES = 50;
/** Most answers one handover carries. */
export const MAX_HANDOVER_ANSWERS = 1000;

/** Everything the next Admin needs from the Admin's phone that is not on a drive. */
export type HandoverPackage = {
  fromName: string;
  invite: { code: string; links?: LinkTime[] };
  retiredInvites?: string[];
  retiredWhy?: Record<string, "turnedOff" | "replaced">;
  answers?: Record<string, "accepted" | "declined">;
  declinedAsks?: Record<string, number>;
  /** One per code in `invite` and `retiredInvites`. */
  chains: Record<string, HandoverProof[]>;
};

/** The bytes an Admin signs to hand `code` to identity `to`. */
export function handoverMessage(code: string, to: string): Uint8Array {
  return Buffer.from(`justus-handover/v1:${code.toLowerCase()}:${to.toLowerCase()}`, "utf8");
}

const isHexOf = (value: unknown, length: number): value is string =>
  typeof value === "string" && new RegExp(`^[0-9a-f]{${length}}$`, "i").test(value);

export function parseProofChain(value: unknown): HandoverProof[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ADMIN_CHAIN) return undefined;
  const out: HandoverProof[] = [];
  for (const raw of value as unknown[]) {
    if (!isTextJSON(raw)) return undefined;
    const { from, to, publicKey, signature } = raw;
    if (!isHexOf(from, 64) || !isHexOf(to, 64) || !isHexOf(publicKey, 64)) return undefined;
    if (!isHexOf(signature, 128)) return undefined;
    out.push({
      from: from.toLowerCase(),
      to: to.toLowerCase(),
      publicKey: publicKey.toLowerCase(),
      signature: signature.toLowerCase(),
    });
  }
  return out;
}

/** True when `chain` hands `code` on from identity `from` to identity `to`: it holds a link from `from`, each link after it starts where the one before ended, the last ends at `to`, and every link verifies. */
export function chainReaches(
  chain: readonly HandoverProof[],
  options: {
    code: string;
    from: string;
    to: string;
    verify: (proof: IdentityProof) => boolean;
  },
): boolean {
  if (chain.length < 1 || chain.length > MAX_ADMIN_CHAIN) return false;
  const from = options.from.toLowerCase();
  const start = chain.findIndex((link) => link.from.toLowerCase() === from);
  if (start < 0) return false;
  for (let i = start; i < chain.length - 1; i++) {
    if (chain[i].to.toLowerCase() !== chain[i + 1].from.toLowerCase()) return false;
  }
  if (chain[chain.length - 1].to.toLowerCase() !== options.to.toLowerCase()) return false;
  return chain.every((link) =>
    options.verify({
      identityKey: link.from,
      publicKey: link.publicKey,
      signature: link.signature,
      message: handoverMessage(options.code, link.to),
    }),
  );
}

function parseLinkTimes(value: unknown): LinkTime[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_HANDOVER_CODES) return undefined;
  const out: LinkTime[] = [];
  for (const raw of value as unknown[]) {
    if (!isTextJSON(raw)) return undefined;
    if (typeof raw.from !== "number" || !Number.isFinite(raw.from)) return undefined;
    if (typeof raw.to !== "number" || !Number.isFinite(raw.to)) return undefined;
    out.push(
      typeof raw.by === "string"
        ? { from: raw.from, to: raw.to, by: peerName(raw.by, DEFAULT_ASK_OWNER) }
        : { from: raw.from, to: raw.to },
    );
  }
  return out;
}

/** A handover package off the wire, or undefined when any part of it is malformed or over its cap. */
export function parseHandoverPackage(value: unknown): HandoverPackage | undefined {
  if (!isTextJSON(value)) return undefined;
  const { invite, retiredInvites, retiredWhy, answers, declinedAsks, chains } = value;
  if (!isTextJSON(invite) || typeof invite.code !== "string" || !isHexKey(invite.code)) {
    return undefined;
  }
  const code = invite.code.toLowerCase();
  const out: HandoverPackage = {
    fromName: peerName(value.fromName, DEFAULT_ASK_OWNER),
    invite: { code },
    chains: {},
  };
  if (invite.links !== undefined) {
    const links = parseLinkTimes(invite.links);
    if (!links) return undefined;
    out.invite.links = links;
  }
  const codes = new Set([code]);
  if (retiredInvites !== undefined) {
    if (!Array.isArray(retiredInvites) || retiredInvites.length > MAX_HANDOVER_CODES) {
      return undefined;
    }
    const retired: string[] = [];
    for (const c of retiredInvites as unknown[]) {
      if (typeof c !== "string" || !isHexKey(c)) return undefined;
      retired.push(c.toLowerCase());
      codes.add(c.toLowerCase());
    }
    out.retiredInvites = retired;
  }
  if (retiredWhy !== undefined) {
    if (!isTextJSON(retiredWhy) || Object.keys(retiredWhy).length > MAX_HANDOVER_CODES) {
      return undefined;
    }
    const why: Record<string, "turnedOff" | "replaced"> = {};
    for (const [c, w] of Object.entries(retiredWhy)) {
      if (!isHexKey(c) || (w !== "turnedOff" && w !== "replaced")) return undefined;
      why[c.toLowerCase()] = w;
    }
    out.retiredWhy = why;
  }
  if (answers !== undefined) {
    if (!isTextJSON(answers) || Object.keys(answers).length > MAX_HANDOVER_ANSWERS) {
      return undefined;
    }
    const parsed: Record<string, "accepted" | "declined"> = {};
    for (const [id, a] of Object.entries(answers)) {
      if (!isHexKey(id) || (a !== "accepted" && a !== "declined")) return undefined;
      parsed[id.toLowerCase()] = a;
    }
    out.answers = parsed;
  }
  if (declinedAsks !== undefined) {
    if (!isTextJSON(declinedAsks) || Object.keys(declinedAsks).length > MAX_HANDOVER_ANSWERS) {
      return undefined;
    }
    const parsed: Record<string, number> = {};
    for (const [id, at] of Object.entries(declinedAsks)) {
      if (!isHexKey(id) || typeof at !== "number" || !Number.isFinite(at)) return undefined;
      parsed[id.toLowerCase()] = at;
    }
    out.declinedAsks = parsed;
  }
  if (!isTextJSON(chains) || Object.keys(chains).length !== codes.size) return undefined;
  for (const c of codes) {
    const proofs = parseProofChain(chains[c]);
    if (!proofs) return undefined;
    out.chains[c] = proofs;
  }
  return out;
}
