import type { JoinRequest, SyncStatus } from "@justus/core";
import { formatRelative } from "./time";

export type Person = {
  key: string;
  /** The name shown: your friend name for them when saved, else their own. */
  name: string;
  /** The name they publish themselves. */
  ownName: string;
  /** Their identity key, the same in every album. Unset for older apps. */
  identity?: string;
  /** Saved on this device as a friend. */
  friend: boolean;
  /** The row can be tapped to open the friend sheet. */
  tappable: boolean;
  admin: boolean;
  /** Accepted as a Viewer: sees every photo, adds none. */
  viewer: boolean;
  you: boolean;
  connected: boolean;
  /** "connected", "last seen 2h ago" or "not seen yet". */
  presence: string;
};

export type People = {
  people: Person[];
  connectedCount: number;
  total: number;
  /** Header chip text, e.g. "3 of 5 connected". */
  chip: string;
  /** Pending join requests for the active album (Admin only). */
  requests: JoinRequest[];
};

/** Presence line for one member. Wording is "connected", never "online". */
export function presenceLabel(
  m: { connected: boolean; lastSeenAt?: number },
  now = Date.now(),
): string {
  if (m.connected) return "connected";
  return m.lastSeenAt ? `last seen ${formatRelative(m.lastSeenAt, now)}` : "not seen yet";
}

/** Chip text counts the others only: you are always connected to yourself. */
function chipText(others: number, connected: number): string {
  return others > 0 ? `${connected} of ${others} connected` : "Just you";
}

/** View-model for the People sheet and the header chip. The first member the
 * backend reports is this device, which always counts as connected. */
export function buildPeople(
  status: SyncStatus | null,
  requests: JoinRequest[],
  friends: Record<string, string> = {},
  now = Date.now(),
): People {
  const members = status?.members ?? [];
  const people = members
    .map((m, i): Person => {
      const you = i === 0;
      const ownName = m.name || "Unknown device";
      const friendName = !you && m.identity !== undefined ? friends[m.identity] : undefined;
      return {
        key: m.key,
        name: friendName ?? ownName,
        ownName,
        identity: m.identity,
        friend: friendName !== undefined,
        tappable: !you && m.identity !== undefined,
        admin: m.admin,
        viewer: m.viewer === true,
        you,
        connected: m.connected,
        presence: you ? "you" : m.viewer ? "can only look" : presenceLabel(m, now),
      };
    })
    .sort((a, b) => Number(b.you) - Number(a.you) || Number(b.admin) - Number(a.admin));
  const connectedCount = members.filter((m) => m.connected).length;
  const folderId = status?.folder.id;
  const isAdmin = status?.folder.role === "creator";
  return {
    people,
    connectedCount,
    total: members.length,
    chip: chipText(members.length - 1, connectedCount - 1),
    requests: isAdmin ? requests.filter((r) => r.folderId === folderId) : [],
  };
}
