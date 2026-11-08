import { copy } from "../copy/copy"; /** What an invite link carries: the invite code, who to ask, and unsigned
 * labels the joiner sees before asking. The album's key is never in a link. */
export type JoinInvite = {
  /** 64-hex invite code. */
  code: string;
  /** 64-hex identity drive key of the album's owner. */
  owner: string;
  /** Album name hint. */
  album: string;
  /** Owner's display name hint. */
  ownerName: string;
  /** When the link stops working, in ms since the epoch. Absent: never. */
  expiresAt?: number;
};

export type ParsedInvite =
  | { kind: "invite"; invite: JoinInvite }
  | { kind: "old"; ownerName: string }
  | { kind: "garbled" };

/** Same cap as a peer name. */
export const MAX_HINT = 80;
const FALLBACK_ALBUM = copy("invite_link.this_album");
const FALLBACK_OWNER = copy("invite_link.the_admin");
const HEX64 = /^[0-9a-f]{64}$/i;
const SECONDS = /^\d{1,12}$/;
const LINK = /justus:\/\/join\?([^\s]*)/i;
const OLD_LINK = /justus:\/\/join\/[0-9a-f]{64}(?![0-9a-f])(?:\?([^\s]*))?/i;

function hint(value: string | null, fallback: string): string {
  const trimmed = (value ?? "").trim().slice(0, MAX_HINT);
  return trimmed === "" ? fallback : trimmed;
}

export function buildInviteLink(invite: JoinInvite): string {
  const params = new URLSearchParams({
    i: invite.code.toLowerCase(),
    o: invite.owner.toLowerCase(),
    ...(invite.expiresAt === undefined ? {} : { e: String(Math.floor(invite.expiresAt / 1000)) }),
    n: invite.album,
    a: invite.ownerName,
  });
  return `justus://join?${params.toString()}`;
}

/** Finds an invite link anywhere in the text. Old-style links are `old`; bare keys are garbled. */
export function parseInviteLink(text: string): ParsedInvite {
  const match = LINK.exec(text);
  if (!match) {
    const old = OLD_LINK.exec(text);
    if (!old) return { kind: "garbled" };
    const ownerName = hint(new URLSearchParams(old[1] ?? "").get("a"), FALLBACK_OWNER);
    return { kind: "old", ownerName };
  }
  const params = new URLSearchParams(match[1]);
  const code = params.get("i");
  const owner = params.get("o");
  if (code === null || owner === null || !HEX64.test(code) || !HEX64.test(owner)) {
    return { kind: "garbled" };
  }
  const end = params.get("e");
  if (end !== null && (!SECONDS.test(end) || Number(end) <= 0)) return { kind: "garbled" };
  return {
    kind: "invite",
    invite: {
      code: code.toLowerCase(),
      owner: owner.toLowerCase(),
      album: hint(params.get("n"), FALLBACK_ALBUM),
      ownerName: hint(params.get("a"), FALLBACK_OWNER),
      ...(end === null ? {} : { expiresAt: Number(end) * 1000 }),
    },
  };
}

/** The invite link a web address carries: `/join?i=…&o=…` reads as the same link text a phone app hands over. Anything else: undefined. */
export function inviteLinkFromAddress(pathname: string, search: string): string | undefined {
  if (pathname.toLowerCase().replace(/\/$/, "") !== "/join") return undefined;
  if (!search.startsWith("?")) return undefined;
  const parsed = parseInviteLink(`justus://join${search}`);
  return parsed.kind === "invite" ? buildInviteLink(parsed.invite) : undefined;
}
