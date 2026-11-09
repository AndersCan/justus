/**
 * The join flow (join, request, accept) over the drive and network ports.
 * photo-store keeps the session state and calls these in order.
 */
import type { Drive, DriveStore, OpenResult } from "../ports/drive-store";
import type { PeerNetwork } from "../ports/peer-network";
import type { JoinRequest } from "@justus/core";
import {
  isHexKey,
  inLinkTime,
  isTextJSON,
  parseFolderName,
  parseJoinRequests,
  parseRegistry,
  parseRequestsFile,
  parseSealedAsk,
  parseViewers,
  type LinkTime,
  type RegistryFile,
  type RequestsFile,
  type ViewersFile,
} from "./records";

export const DRIVE_PATH_MEMBERS = "/members.json";
export const DRIVE_PATH_VIEWERS = "/viewers.json";
export const DRIVE_PATH_FOLDER = "/folder.json";
export const DRIVE_PATH_REQUESTS = "/requests.json";
/** Cap on a small JSON record read off a drive. Any member, or any peer on an album
 * topic for `/requests.json`, controls these bytes; without a cap one file can
 * exhaust memory. 1 MiB holds thousands of members. */
export const MAX_PEER_JSON_BYTES = 1024 * 1024;

/** A peer record that is not on this device and cannot be fetched (the peer left) reads as missing after this long; the next poll retries. */
const PEER_READ_TIMEOUT_MS = 5_000;

export type JoinLog = (
  event: string,
  fields?: Record<string, string | number | boolean | undefined>,
) => void;

export type JoinPorts = {
  drives: DriveStore;
  network: PeerNetwork;
  log: JoinLog;
  /** Max ms to wait for a remote drive to be ready. */
  openTimeoutMs: number;
};

export type JoinError =
  | { kind: "cannot-open"; message: string }
  | { kind: "already-enrolled"; message: string }
  | { kind: "write-failed"; message: string };

/** The repo's error tuple (ADR 0002 decision 8, same shape as OpenResult). */
export type JoinResult<T> = [JoinError, null] | [null, T];

export type FoundJoinRequest = {
  request: JoinRequest;
  /** Identity drive whose outbox listed it. */
  identity: string;
  /** Made through the folder's invite code. */
  viaInvite: boolean;
  /** Asked through a code held at a Remove: link times of the current code do not apply. */
  held?: true;
};

export type FoundJoinRequests = {
  requests: FoundJoinRequest[];
  /** Requester keys listed by more than one outbox: dropped (anyone can write any key into their own outbox). */
  ambiguous: string[];
};

function short(hex: string): string {
  return hex.slice(0, 8);
}

function errText(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}

/** Reads a small text record, or null when missing, unreadable, or larger
 * than {@link MAX_PEER_JSON_BYTES}. */
export async function readRecord(
  drive: Drive,
  options: { path: string; log: JoinLog; timeoutMs?: number },
): Promise<string | null> {
  const { path, log, timeoutMs } = options;
  try {
    const text = await drive.readSmall(
      path,
      MAX_PEER_JSON_BYTES,
      timeoutMs === undefined ? undefined : { timeoutMs },
    );
    return text ?? null;
  } catch (thrown: unknown) {
    log("error", { where: "drive.read", drive: short(drive.key), path, err: errText(thrown) });
    return null;
  }
}

export async function readRegistry(drive: Drive, options: { log: JoinLog }): Promise<RegistryFile> {
  return parseRegistry(await readRecord(drive, { path: DRIVE_PATH_MEMBERS, log: options.log }));
}

export async function readViewers(drive: Drive, options: { log: JoinLog }): Promise<ViewersFile> {
  return parseViewers(await readRecord(drive, { path: DRIVE_PATH_VIEWERS, log: options.log }));
}

/** Opens a drive by key, joining its swarm topic first so peers serve its
 * blocks (a remote `drive.ready()` otherwise waits forever). */
export async function openWithTopic(
  ports: JoinPorts,
  options: { key: string; server: boolean },
): Promise<OpenResult<Drive>> {
  const { drives, network, log, openTimeoutMs } = ports;
  const { key, server } = options;
  const topic = drives.discoveryKeyOf(key);
  const startedAt = Date.now();
  log("drive.open.start", { drive: short(key), topic: short(topic) });
  network.join(topic, { server });
  const [openErr, drive] = await drives.open(key, { timeoutMs: openTimeoutMs });
  if (openErr) {
    log("drive.open.timeout", {
      drive: short(key),
      ms: Date.now() - startedAt,
      err: errText(openErr),
      conns: network.connectionCount(),
    });
    return [openErr, null];
  }
  log("drive.open.ready", {
    drive: short(key),
    ms: Date.now() - startedAt,
    peers: drive.stats().peers,
  });
  network.findPeers(topic, () => drive.stats().peers > 0, {
    drive: drive.key,
    peers: () => drive.stats().peers,
  });
  return [null, drive];
}

/** Opens the album to join: its share drive, the registry and the folder name. */
export async function openAlbum(
  ports: JoinPorts,
  options: { shareKey: string },
): Promise<JoinResult<{ folderDrive: Drive; registry: RegistryFile; folderName: string }>> {
  const [openErr, folderDrive] = await openWithTopic(ports, {
    key: options.shareKey,
    server: false,
  });
  if (openErr) return [{ kind: "cannot-open", message: errText(openErr) }, null];
  const registry = await readRegistry(folderDrive, { log: ports.log });
  const folderName = parseFolderName(
    await readRecord(folderDrive, { path: DRIVE_PATH_FOLDER, log: ports.log }),
  );
  return [null, { folderDrive, registry, folderName }];
}

/** Files (or re-files) this device's request to join an album on its identity
 * drive's outbox, then serves the album topic so the Admin can reach it. */
export async function writeJoinRequest(
  ports: JoinPorts,
  options: {
    identityDrive: Drive;
    folderDrive: Drive;
    shareKey: string;
    requesterKey: string;
    requesterName: string;
    folderName: string;
  },
): Promise<JoinResult<undefined>> {
  const { identityDrive, folderDrive, shareKey, requesterKey, requesterName, folderName } = options;
  const existingText = await readRecord(identityDrive, {
    path: DRIVE_PATH_REQUESTS,
    log: ports.log,
  });
  const file: RequestsFile = (existingText && parseRequestsFile(existingText)) || {
    version: 1,
    requests: {},
  };
  file.requests[shareKey] = {
    requesterKey,
    requesterName,
    shareKey,
    folderName,
    requestedAt: Date.now(),
  };
  try {
    await identityDrive.put(DRIVE_PATH_REQUESTS, Buffer.from(JSON.stringify(file)));
  } catch (thrown: unknown) {
    return [{ kind: "write-failed", message: errText(thrown) }, null];
  }
  try {
    ports.network.join(folderDrive.discoveryKey, { server: true });
    ports.network.findPeers(folderDrive.discoveryKey, () => folderDrive.stats().peers > 0, {
      drive: folderDrive.key,
      peers: () => folderDrive.stats().peers,
    });
  } catch (thrown: unknown) {
    console.error(`[justus] failed to announce drive on folder topic: ${errText(thrown)}`);
  }
  return [null, undefined];
}

/** Requester keys in an outbox that asked through `code`. */
function inviteRequesters(text: string, code: string | undefined): Set<string> {
  const out = new Set<string>();
  const file = code ? parseRequestsFile(text) : undefined;
  for (const raw of Object.values(file?.requests ?? {}) as unknown[]) {
    if (!isTextJSON(raw) || raw.invite !== code) continue;
    if (typeof raw.requesterKey === "string" && isHexKey(raw.requesterKey)) {
      out.add(raw.requesterKey.toLowerCase());
    }
  }
  return out;
}

/** The outbox text with each invite entry for `code` given the `requesterKey`
 * its `sealedKey` opens to. An entry with no seal, a seal that cannot be opened,
 * or one that names another identity or code than the entry's, is dropped and
 * logged. */
async function openSealedEntries(
  text: string,
  options: {
    code: string | undefined;
    identity: string;
    openSealed: (sealed: string) => Promise<OpenResult<Uint8Array>>;
    log: JoinLog;
  },
): Promise<string> {
  const { code, identity, openSealed, log } = options;
  const file = code ? parseRequestsFile(text) : undefined;
  if (!file) return text;
  const requests: Record<string, unknown> = {};
  for (const [id, raw] of Object.entries(file.requests) as Array<[string, unknown]>) {
    if (!isTextJSON(raw) || raw.invite !== code) {
      requests[id] = raw;
      continue;
    }
    const drop = (reason: string) =>
      log("requests.sealed.dropped", { identity: short(identity), reason });
    if (raw.sealedKey === undefined) {
      drop("plain");
      continue;
    }
    if (typeof raw.sealedKey !== "string" || !/^[0-9a-f]+$/i.test(raw.sealedKey)) {
      drop("not-ours");
      continue;
    }
    const [openErr, bytes] = await openSealed(raw.sealedKey);
    const sealed = openErr ? undefined : parseSealedAsk(bytes);
    if (!sealed) {
      drop("not-ours");
    } else if (sealed.identity !== identity.toLowerCase()) {
      drop("identity");
    } else if (sealed.invite !== code) {
      drop("invite");
    } else {
      requests[id] = { ...raw, requesterKey: sealed.key };
    }
  }
  return JSON.stringify({ version: 1, requests });
}

/** Reads the album's join requests off every identity's outbox, concurrently
 * so unreachable peers cost one timeout in total. A requester key listed by
 * more than one outbox is returned in `ambiguous` and in no request. */
export async function readJoinRequests(
  openOutbox: (identityKey: string) => Promise<OpenResult<Drive>>,
  options: {
    identities: Iterable<string>;
    folder: { id: string; name: string; shareKey: string; inviteCode?: string };
    openSealed: (sealed: string) => Promise<OpenResult<Uint8Array>>;
    log: JoinLog;
  },
): Promise<FoundJoinRequests> {
  const { folder, log } = options;
  const tasks = [...options.identities].map(async (identity) => {
    const empty = { identity, found: [] as JoinRequest[], invited: new Set<string>() };
    const [openErr, drive] = await openOutbox(identity);
    if (openErr) {
      console.error(
        `[justus] cannot open requester drive ${identity.slice(0, 12)}: ${errText(openErr)}`,
      );
      return empty;
    }
    let text = await readRecord(drive, {
      path: DRIVE_PATH_REQUESTS,
      log,
      timeoutMs: PEER_READ_TIMEOUT_MS,
    });
    if (text === null) return empty;
    text = await openSealedEntries(text, {
      code: folder.inviteCode,
      identity,
      openSealed: options.openSealed,
      log,
    });
    const found = parseJoinRequests(text, {
      shareKey: folder.shareKey,
      folderId: folder.id,
      folderName: folder.name,
      inviteCode: folder.inviteCode,
    });
    return { identity, found, invited: inviteRequesters(text, folder.inviteCode) };
  });
  const settled = await Promise.allSettled(tasks);
  const listed = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  const owners = new Map<string, Set<string>>();
  for (const l of listed) {
    for (const req of l.found) {
      const set = owners.get(req.requesterKey) ?? new Set<string>();
      set.add(l.identity);
      owners.set(req.requesterKey, set);
    }
  }
  const requests: FoundJoinRequest[] = [];
  const ambiguous: string[] = [];
  for (const l of listed) {
    for (const req of l.found) {
      if ((owners.get(req.requesterKey)?.size ?? 0) > 1) {
        if (!ambiguous.includes(req.requesterKey)) ambiguous.push(req.requesterKey);
        continue;
      }
      requests.push({
        request: req,
        identity: l.identity,
        viaInvite: l.invited.has(req.requesterKey),
      });
    }
  }
  return { requests, ambiguous };
}

function answerClosesRequest(
  f: FoundJoinRequest,
  options: {
    answers: Record<string, "accepted" | "declined"> | undefined;
    declinedAsks?: Readonly<Record<string, number>>;
  },
): boolean {
  const answer = options.answers?.[f.identity];
  if (!answer) return false;
  if (answer === "accepted") return true;
  const answeredAsk = options.declinedAsks?.[f.identity];
  return answeredAsk === undefined || f.request.requestedAt <= answeredAsk;
}

/** The requests still waiting on the Admin: not enrolled, not denied, and not
 * an invite request that already has an answer. */
export function pendingJoinRequests(
  found: FoundJoinRequest[],
  options: {
    registry: RegistryFile;
    denied: ReadonlySet<string>;
    answers: Record<string, "accepted" | "declined"> | undefined;
    /** When the ask each declined identity was answered on; a newer request is listed again. */
    declinedAsks?: Readonly<Record<string, number>>;
    /** Identities with an open friend invite to this album: the Admin's phone lets
     * them in itself (`acceptOfferedFriend`), so they are not listed. */
    invited?: ReadonlySet<string>;
    /** When the album's invite links worked; an invite ask sent outside them is not listed. */
    linkTimes?: readonly LinkTime[];
    /** Keys accepted as Viewers: no longer pending. */
    viewers?: ReadonlySet<string>;
    /** Works out the check code for an identity; when absent, requests carry none. */
    checkCodeOf?: (identity: string) => string;
  },
): JoinRequest[] {
  const enrolled = new Set(Object.values(options.registry.members).map((m) => m.key));
  return found
    .filter((f) => {
      const key = f.request.requesterKey;
      if (options.invited?.has(f.identity)) return false;
      if (f.viaInvite && !f.held && !inLinkTime(options.linkTimes, f.request.requestedAt))
        return false;
      if (enrolled.has(key)) return false;
      if (options.viewers?.has(key)) return false;
      if (options.denied.has(key)) return false;
      if (f.viaInvite && answerClosesRequest(f, options)) return false;
      return true;
    })
    .map((f) => {
      const withIdentity = { ...f.request, requesterIdentity: f.identity };
      const base = f.viaInvite ? { ...withIdentity, viaInvite: true } : withIdentity;
      const flagged =
        f.viaInvite && options.answers?.[f.identity] === "declined"
          ? { ...base, declinedEarlier: true }
          : base;
      return options.checkCodeOf
        ? { ...flagged, checkCode: options.checkCodeOf(f.identity) }
        : flagged;
    });
}

/** Add the requester to the registry. The name comes from the requester's own
 * request, else a neutral label. The input registry is not changed. */
export async function acceptJoinRequest(
  folderDrive: Drive,
  options: { registry: RegistryFile; requesterKey: string; requests: JoinRequest[] },
): Promise<JoinResult<{ registry: RegistryFile; member: RegistryFile["members"][string] }>> {
  const { registry, requesterKey, requests } = options;
  if (registry.members[requesterKey]) {
    return [{ kind: "already-enrolled", message: "Member already enrolled" }, null];
  }
  const name = requests.find((r) => r.requesterKey === requesterKey)?.requesterName ?? "New member";
  const next: RegistryFile = {
    ...registry,
    members: {
      ...registry.members,
      [requesterKey]: { key: requesterKey, name, addedAt: Date.now() },
    },
  };
  try {
    await folderDrive.put(DRIVE_PATH_MEMBERS, Buffer.from(JSON.stringify(next)));
  } catch (e) {
    return [{ kind: "write-failed", message: errText(e) }, null];
  }
  return [null, { registry: next, member: next.members[requesterKey] }];
}
