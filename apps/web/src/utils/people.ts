import type { JoinRequest, SyncStatus } from "@justus/core";
import { formatRelative } from "./time";

import { copy } from "../copy/copy";
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
  /** Saved friend name this non-friend's own name equals. */
  clash?: string;
  /** The row can be tapped to open the friend sheet. */
  tappable: boolean;
  /** Their seat in the album's palette, written by the Admin. Unset until they have one. */
  color?: number;
  admin: boolean;
  /** Accepted as a Viewer: sees every photo, adds no photos. */
  viewer: boolean;
  /** What the row's line says this person can do. The own row follows the
   * album; "waiting" is the own row before the Admin accepts, and shows the waiting line. */
  role: "admin" | "collaborator" | "viewer" | "waiting";
  you: boolean;
  connected: boolean;
  /** "connected", "last seen 2h ago" or "not seen yet". */
  presence: string;
};

/** A pending join request with the name to show: your friend name for the
 * asker when their identity key is a saved friend. */
export type RequestRow = JoinRequest & { name: string; friend: boolean; clash?: string };

export type People = {
  people: Person[];
  connectedCount: number;
  total: number;
  /** Header chip text, e.g. "3 of 5 connected". */
  chip: string;
  /** Pending join requests for the active album (Admin only). */
  requests: RequestRow[];
};

function nameKey(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/** The saved friend name a non-friend's typed name equals, ignoring case and
 * spacing. undefined when none matches. */
export function clashFriend(name: string, friends: Record<string, string>): string | undefined {
  const key = nameKey(name);
  if (key === "") return undefined;
  let found: string | undefined;
  for (const saved of Object.values(friends)) {
    if (nameKey(saved) === key && (found === undefined || saved < found)) found = saved;
  }
  return found;
}

/** One request as its row shows it: the saved friend name when known, a lookalike warning otherwise. */
export function requestRowOf(r: JoinRequest, friends: Record<string, string>): RequestRow {
  const friendName = r.requesterIdentity !== undefined ? friends[r.requesterIdentity] : undefined;
  const friend = friendName !== undefined;
  const clash = friend ? undefined : clashFriend(r.requesterName, friends);
  return {
    ...r,
    name: friendName ?? r.requesterName,
    friend,
    ...(clash !== undefined && { clash }),
  };
}

/** The line above the requests: how many asked by link (at 2 or more), then ask for the check code. */
export function requestsHint(rows: RequestRow[]): string {
  const links = rows.filter((r) => r.viaInvite === true).length;
  const rest = rows.some((r) => r.clash !== undefined)
    ? copy("people.someone_not_in_your_friends")
    : rows.some((r) => r.checkCode)
      ? copy("people.not_sure_who_it_is")
      : "";
  if (links < 2) return rest;
  const count = copy("album.people_asked_with_link", { count: links });
  return rest === "" ? count : `${count} ${rest}`;
}

/** Presence line for one member. Wording is "connected", never "online". */
export function presenceLabel(
  m: { connected: boolean; lastSeenAt?: number },
  now = Date.now(),
): string {
  if (m.connected) return "connected";
  return m.lastSeenAt
    ? copy("people.last_seen", { when: formatRelative(m.lastSeenAt, now) })
    : copy("people.not_seen_yet");
}

/** Chip text counts the others only: you are always connected to yourself. */
function chipText(others: number, connected: number): string {
  return others > 0 ? copy("people.of_connected", { connected, others }) : copy("people.just_you");
}

function ownRole(folder: SyncStatus["folder"] | undefined): Person["role"] {
  if (folder?.pending) return "waiting";
  if (folder?.role === "creator") return "admin";
  if (folder?.role === "reader") return "viewer";
  return "collaborator";
}

function otherRole(m: { admin: boolean; viewer?: boolean }): Person["role"] {
  if (m.admin) return "admin";
  return m.viewer === true ? "viewer" : "collaborator";
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
      const ownName = m.name || copy("people.unknown_device");
      const friendName = !you && m.identity !== undefined ? friends[m.identity] : undefined;
      const friend = friendName !== undefined;
      const clash = !you && !friend ? clashFriend(ownName, friends) : undefined;
      return {
        key: m.key,
        name: friendName ?? ownName,
        ownName,
        identity: m.identity,
        friend,
        ...(clash !== undefined && { clash }),
        tappable: !you && m.identity !== undefined,
        ...(m.color !== undefined && { color: m.color }),
        admin: m.admin,
        viewer: m.viewer === true,
        role: you ? ownRole(status?.folder) : otherRole(m),
        you,
        connected: m.connected,
        presence: you ? "you" : presenceLabel(m, now),
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
    requests: isAdmin
      ? requests.filter((r) => r.folderId === folderId).map((r) => requestRowOf(r, friends))
      : [],
  };
}

/** Names joined for a sentence: "Ann", "Ann and Bo", "Ann, Bo and Cy". */
export function nameList(names: readonly string[]): string {
  if (names.length < 2) return names[0] ?? "";
  return copy("album.and", {
    others: names.slice(0, -1).join(", "),
    last: names[names.length - 1],
  });
}
