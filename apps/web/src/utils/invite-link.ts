/** What an invite link carries: the invite code, who to ask, and unsigned
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
};

export type ParsedInvite = { kind: "invite"; invite: JoinInvite } | { kind: "garbled" };

/** Same cap as a peer name. */
export const MAX_HINT = 80;
const FALLBACK_ALBUM = "this album";
const FALLBACK_OWNER = "the Admin";
const HEX64 = /^[0-9a-f]{64}$/i;
const LINK = /justus:\/\/join\?([^\s]*)/i;

function hint(value: string | null, fallback: string): string {
  const trimmed = (value ?? "").trim().slice(0, MAX_HINT);
  return trimmed === "" ? fallback : trimmed;
}

export function buildInviteLink(invite: JoinInvite): string {
  const params = new URLSearchParams({
    i: invite.code.toLowerCase(),
    o: invite.owner.toLowerCase(),
    n: invite.album,
    a: invite.ownerName,
  });
  return `justus://join?${params.toString()}`;
}

/** Finds an invite link anywhere in the text. Old-style links and bare keys are garbled. */
export function parseInviteLink(text: string): ParsedInvite {
  const match = LINK.exec(text);
  if (!match) return { kind: "garbled" };
  const params = new URLSearchParams(match[1]);
  const code = params.get("i");
  const owner = params.get("o");
  if (code === null || owner === null || !HEX64.test(code) || !HEX64.test(owner)) {
    return { kind: "garbled" };
  }
  return {
    kind: "invite",
    invite: {
      code: code.toLowerCase(),
      owner: owner.toLowerCase(),
      album: hint(params.get("n"), FALLBACK_ALBUM),
      ownerName: hint(params.get("a"), FALLBACK_OWNER),
    },
  };
}
