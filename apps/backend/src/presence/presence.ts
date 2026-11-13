/**
 * Which album members this device is connected to, matched by the peer key
 * each member publishes in its `/device.json`. photo-store feeds it
 * connection events and keeps the stored file and the web notification.
 */
import type { Drive, IdentityProof } from "../ports/drive-store";
import { isTextJSON, verifiedDeviceIdentity, parseDeviceSwarmKey } from "../membership/records";
import { errText, short, type P2pLog } from "../p2p-log.ts";

const DRIVE_PATH_DEVICE = "/device.json";
/** Same cap as membership/join's MAX_PEER_JSON_BYTES: peers control these bytes. */
const MAX_RECORD_BYTES = 1024 * 1024;

export type PresenceLog = P2pLog;

export type Presence = {
  /** Live connections per peer key; one peer can hold several. */
  connections: Map<string, number>;
  /** Member drive key to the peer key named in that member's `/device.json`. */
  peerKeys: Map<string, string>;
  /** Member drive key to the identity drive key named in their `/device.json`. */
  identities: Map<string, string>;
  /** Member drive key to why their `/device.json` identity is not trusted. */
  unverified: Map<string, "unsigned" | "rejected">;
  /** Member drive key to the last time (ms epoch) their last connection closed. */
  lastSeen: Map<string, number>;
};

/** What a member's entry in the People sheet takes from presence. Unset fields are absent. */
export type MemberPresence = { connected: boolean; lastSeenAt?: number; identity?: string };

/** What a closed connection meant. */
export type PeerDown = "still-connected" | "unknown-peer-down" | "member-down";

export type DeviceSource = { memberKey: string; drive: Drive };

export function createPresence(options: { lastSeen: [string, number][] }): Presence {
  return {
    connections: new Map(),
    peerKeys: new Map(),
    identities: new Map(),
    unverified: new Map(),
    lastSeen: new Map(options.lastSeen),
  };
}

export function parseLastSeen(text: string): [string, number][] {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isTextJSON(parsed)) return [];
    return Object.entries(parsed).filter((e): e is [string, number] => typeof e[1] === "number");
  } catch {
    return [];
  }
}

export function serializeLastSeen(presence: Presence): string {
  return JSON.stringify(Object.fromEntries(presence.lastSeen));
}

function memberForPeerKey(presence: Presence, peerKey: string): string | undefined {
  for (const [member, key] of presence.peerKeys) if (key === peerKey) return member;
  return undefined;
}

export function peerConnected(presence: Presence, options: { peerKey: string; log: PresenceLog }) {
  const { peerKey, log } = options;
  const n = (presence.connections.get(peerKey) ?? 0) + 1;
  presence.connections.set(peerKey, n);
  if (n !== 1) return;
  const member = memberForPeerKey(presence, peerKey);
  log("presence.change", {
    swarmkey: short(peerKey),
    member: member === undefined ? undefined : short(member),
    state: "up",
    conns: n,
  });
}

export function peerDisconnected(
  presence: Presence,
  options: { peerKey: string; now: number; log: PresenceLog },
): PeerDown {
  const { peerKey, now, log } = options;
  const left = (presence.connections.get(peerKey) ?? 1) - 1;
  if (left > 0) {
    presence.connections.set(peerKey, left);
    return "still-connected";
  }
  presence.connections.delete(peerKey);
  const member = memberForPeerKey(presence, peerKey);
  log("presence.change", {
    swarmkey: short(peerKey),
    member: member === undefined ? undefined : short(member),
    state: "down",
    conns: 0,
  });
  if (member === undefined) return "unknown-peer-down";
  presence.lastSeen.set(member, now);
  return "member-down";
}

export function memberPresence(presence: Presence, memberKey: string): MemberPresence {
  const peerKey = presence.peerKeys.get(memberKey);
  const connected = peerKey !== undefined && (presence.connections.get(peerKey) ?? 0) > 0;
  const seen = presence.lastSeen.get(memberKey);
  const identity = presence.identities.get(memberKey);
  return {
    connected,
    ...(seen !== undefined ? { lastSeenAt: seen } : {}),
    ...(identity !== undefined ? { identity } : {}),
  };
}

async function readDevice(drive: Drive, log: PresenceLog): Promise<string | undefined> {
  try {
    return await drive.readSmall(DRIVE_PATH_DEVICE, MAX_RECORD_BYTES);
  } catch (thrown) {
    log("error", {
      where: "drive.read",
      drive: short(drive.key),
      path: DRIVE_PATH_DEVICE,
      err: errText(thrown),
    });
    return undefined;
  }
}

/** Re-read every time: the peer key changes on every boot. True when the key or identity is new or changed. */
async function learnDevice(
  presence: Presence,
  options: {
    source: DeviceSource;
    timeoutMs: number;
    log: PresenceLog;
    verify: (proof: IdentityProof) => boolean;
  },
): Promise<boolean> {
  const { source, timeoutMs, log, verify } = options;
  const { memberKey } = source;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const text = await Promise.race([
    readDevice(source.drive, log),
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
  if (!text) return false;
  let changed = false;
  const device = verifiedDeviceIdentity(text, { driveKey: source.drive.key, verify });
  if (device.status === "verified") {
    presence.unverified.delete(memberKey);
    if (presence.identities.get(memberKey) !== device.identityKey) {
      presence.identities.set(memberKey, device.identityKey);
      changed = true;
    }
  } else if (presence.unverified.get(memberKey) !== device.status) {
    presence.unverified.set(memberKey, device.status);
    log("identity.unverified", { member: short(memberKey), status: device.status });
  }
  const peerKey = parseDeviceSwarmKey(text);
  if (peerKey === undefined) return changed;
  const prev = presence.peerKeys.get(memberKey);
  if (prev === peerKey) return changed;
  presence.peerKeys.set(memberKey, peerKey);
  log(prev !== undefined ? "swarmkey.changed" : "swarmkey.learned", {
    member: short(memberKey),
    swarmkey: short(peerKey),
    from: prev === undefined ? undefined : short(prev),
  });
  return true;
}

/** Read every source's `/device.json`, each cut off after `timeoutMs`. True when anything was learned. */
export async function learnDevices(
  presence: Presence,
  options: {
    sources: DeviceSource[];
    timeoutMs: number;
    log: PresenceLog;
    verify: (proof: IdentityProof) => boolean;
  },
): Promise<boolean> {
  const { sources, timeoutMs, log, verify } = options;
  const results = await Promise.all(
    sources.map((source) => learnDevice(presence, { source, timeoutMs, log, verify })),
  );
  return results.some(Boolean);
}
