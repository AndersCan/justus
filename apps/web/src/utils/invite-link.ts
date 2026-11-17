import { copy } from "../copy/copy"; /** What an invite link carries: the code, who to ask, when it ends. Never a name:
 * the names a joiner reads come from the Admin's phone. */
export type JoinInvite = {
  /** 64-hex invite code. */
  code: string;
  /** 64-hex identity drive key of the album's owner. */
  owner: string;
  /** When the link stops working, in ms since the epoch. Absent: never. */
  expiresAt?: number;
};

/** Names the sender typed into the link, written only for the browser join page. The app never reads them back. */
export type LinkHints = { album: string; ownerName: string };

export type ParsedInvite =
  | { kind: "invite"; invite: JoinInvite }
  | { kind: "old" }
  | { kind: "garbled" };

const HEX64 = /^[0-9a-f]{64}$/i;
const SECONDS = /^\d{1,12}$/;
/** The page people open from a chat. The invite sits after the "#", which browsers never send. */
export const INVITE_PAGE = "https://anderscan.github.io/justus/join/";
const PAGE_LINK = /https:\/\/anderscan\.github\.io\/justus\/join\/?#([^\s]*)/i;
const LINK = /justus:\/\/join\?([^\s]*)/i;
const OLD_LINK = /justus:\/\/join\/[0-9a-f]{64}(?![0-9a-f])(?:\?([^\s]*))?/i;

/** The owner as the joiner reads them: their name, or "the person who invited you" when this phone
 * does not know it. "" and the backend's stand-in "the Admin" (DEFAULT_ASK_OWNER, records.ts) both mean
 * unknown, so someone who really is named "the Admin" reads as unknown too.
 * `at`: "start" when the name opens a sentence. */
export function ownerShown(name: string, at: "start" | "mid"): string {
  const clean = name.trim();
  if (clean === "" || clean === "the Admin") {
    return at === "start"
      ? copy("invite_link.the_person_who_invited_you_2")
      : copy("invite_link.the_person_who_invited_you");
  }
  return name;
}

/** docs/site/public/join/join.js reads this link; scripts/join-page.test.ts pins both. */
export function buildInviteLink(invite: JoinInvite & LinkHints): string {
  const params = new URLSearchParams({
    i: invite.code.toLowerCase(),
    o: invite.owner.toLowerCase(),
    ...(invite.expiresAt === undefined ? {} : { e: String(Math.floor(invite.expiresAt / 1000)) }),
    n: invite.album,
    a: invite.ownerName,
  });
  return `${INVITE_PAGE}#${params.toString()}`;
}

/** Finds an invite link anywhere in the text: the https page link or `justus://join?`. Old-style links are `old`; bare keys are garbled. */
export function parseInviteLink(text: string): ParsedInvite {
  const match = PAGE_LINK.exec(text) ?? LINK.exec(text);
  if (!match) {
    return OLD_LINK.test(text) ? { kind: "old" } : { kind: "garbled" };
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
      ...(end === null ? {} : { expiresAt: Number(end) * 1000 }),
    },
  };
}

/** The invite link a web address carries: `/join?i=…&o=…` reads as the https invite link the app hands out. Anything else: undefined. */
export function inviteLinkFromAddress(pathname: string, search: string): string | undefined {
  if (pathname.toLowerCase().replace(/\/$/, "") !== "/join") return undefined;
  if (!search.startsWith("?")) return undefined;
  const parsed = parseInviteLink(`justus://join${search}`);
  return parsed.kind === "invite"
    ? buildInviteLink({ ...parsed.invite, album: "", ownerName: "" })
    : undefined;
}
