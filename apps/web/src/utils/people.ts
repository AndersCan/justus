import type { JoinRequest, SyncStatus } from "@justus/core";
import { formatRelative } from "./time";

export type Person = {
  key: string;
  name: string;
  admin: boolean;
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

/** View-model for the People sheet and the header chip. The first member the
 * backend reports is this device, which always counts as connected. */
export function buildPeople(
  status: SyncStatus | null,
  requests: JoinRequest[],
  now = Date.now(),
): People {
  const members = status?.members ?? [];
  const people = members
    .map((m, i) => ({
      key: m.key,
      name: m.name || "Unknown device",
      admin: m.admin,
      you: i === 0,
      connected: m.connected,
      presence: i === 0 ? "you" : presenceLabel(m, now),
    }))
    .sort((a, b) => Number(b.you) - Number(a.you) || Number(b.admin) - Number(a.admin));
  const connectedCount = members.filter((m) => m.connected).length;
  const folderId = status?.folder.id;
  const isAdmin = status?.folder.role === "creator";
  return {
    people,
    connectedCount,
    total: members.length,
    chip: `${connectedCount} of ${members.length} connected`,
    requests: isAdmin ? requests.filter((r) => r.folderId === folderId) : [],
  };
}
