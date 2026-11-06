import type { JoinRequest } from "@justus/core";

export type RegistryFile = {
  version: 1;
  members: Record<string, { key: string; name: string; addedAt: number }>;
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
  | { code: string; answer: "declined" };

/** An answer off the wire, or undefined when it is malformed. */
export function parseAnswer(value: unknown): Answer | undefined {
  if (!isTextJSON(value)) return undefined;
  const { code, answer, shareKey } = value as {
    code?: unknown;
    answer?: unknown;
    shareKey?: unknown;
  };
  if (typeof code !== "string" || !isHexKey(code)) return undefined;
  if (answer === "declined") return { code, answer };
  if (answer === "accepted" && typeof shareKey === "string" && isHexKey(shareKey)) {
    return { code, answer, shareKey };
  }
  return undefined;
}
