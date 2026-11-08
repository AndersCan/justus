import type { JoinRequest } from "@justus/core";
import type { IdentityProof } from "../ports/drive-store";

export type RegistryFile = {
  version: 1;
  members: Record<string, { key: string; name: string; addedAt: number }>;
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
    }
  >;
};

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
      requesterKey: string;
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

export function parseRegistry(text: string | null): RegistryFile {
  if (text === null) return { version: 1, members: {} };
  try {
    const parsed = JSON.parse(text) as { version?: unknown; members?: unknown };
    if (parsed.version === 1 && isTextJSON(parsed.members)) {
      return { version: 1, members: parsed.members as RegistryFile["members"] };
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
      viewers[recordKey] = {
        key: recordKey,
        name: peerName(raw.name, "New member"),
        addedAt: raw.addedAt,
        ...(keptVersion === undefined ? {} : { keptVersion }),
      };
    }
    return { version: 1, viewers };
  } catch {
    return empty;
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

/** What an Admin tells a joiner who asked through an invite code (`justus/answer/v1`). */
export type Answer =
  | { code: string; answer: "accepted"; shareKey: string }
  | { code: string; answer: "declined"; askedAt?: number };

/** An answer off the wire, or undefined when it is malformed. */
export function parseAnswer(value: unknown): Answer | undefined {
  if (!isTextJSON(value)) return undefined;
  const { code, answer, shareKey, askedAt } = value as {
    code?: unknown;
    answer?: unknown;
    shareKey?: unknown;
    askedAt?: unknown;
  };
  if (typeof code !== "string" || !isHexKey(code)) return undefined;
  if (answer === "declined") {
    return typeof askedAt === "number" && Number.isFinite(askedAt)
      ? { code, answer, askedAt }
      : { code, answer };
  }
  if (answer === "accepted" && typeof shareKey === "string" && isHexKey(shareKey)) {
    return { code, answer, shareKey };
  }
  return undefined;
}

/** Shown when a peer's invite names no album. */
export const DEFAULT_ASK_ALBUM = "this album";
/** Shown when a peer's invite names no Admin. */
export const DEFAULT_ASK_OWNER = "the Admin";

/** Messages between an Admin and a friend about an album invite. `code` is the album's invite code, never a key. */
export type FriendMessage =
  | { kind: "offer"; code: string; albumName: string; ownerName: string }
  | { kind: "offerSeen"; code: string }
  | { kind: "offerRefused"; code: string }
  | { kind: "offerWithdrawn"; code: string }
  | { kind: "offerTaken"; code: string };

/** Everything the answer channel carries. */
export type ChannelMessage = Answer | FriendMessage;

/** True for a value that belongs to {@link parseFriendMessage}, not {@link parseAnswer}. */
export function isFriendMessageShape(value: unknown): boolean {
  return isTextJSON(value) && typeof value.kind === "string";
}

/** A friend message off the wire, or undefined when it is malformed. */
export function parseFriendMessage(value: unknown): FriendMessage | undefined {
  if (!isTextJSON(value)) return undefined;
  const { kind, code, albumName, ownerName } = value;
  if (typeof code !== "string" || !isHexKey(code)) return undefined;
  if (kind === "offer") {
    return {
      kind,
      code,
      albumName: peerName(albumName, DEFAULT_ASK_ALBUM),
      ownerName: peerName(ownerName, DEFAULT_ASK_OWNER),
    };
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
