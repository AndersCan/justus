/**
 * Turns an error message from an actor (often a raw backend or transport
 * string, e.g. "Share key must be a 64-char hex key") into a sentence a
 * non-technical user can act on. Code words (key, hex, creator, reader,
 * drive) never reach the screen; the raw text stays available for the
 * diagnostics log and as the banner's tooltip.
 */

const RULES: [RegExp, string][] = [
  [/^Share key must be/i, "That invite link doesn't look right. Check you copied all of it."],
  [
    /^(Drive|Member|Requester) key must be/i,
    "That drive key doesn't look right. Check you copied all of it.",
  ],
  [/^You already own this album/i, "You started this album, so it's already here."],
  [/Readers cannot add photos/i, "You can't add photos here until the Admin approves you."],
  [
    /^Only the (creator|Admin)|not the Admin/i,
    "Only the Admin, who started this album, can do that.",
  ],
  [/^Member already enrolled/i, "They can already add photos."],
  [/^You cannot enroll yourself/i, "That is this phone's own drive key."],
  [/^No such member|no member to remove/i, "That person isn't in this album anymore."],
  [/^(Album name|Name) is required|no album name|no name given/i, "Enter a name to continue."],
  [
    /timeout opening remote drive/i,
    "Couldn't find the album. Ask the person who invited you to open Justus, then try again.",
  ],
  [
    /^(Cannot open album|No album|No album is active|no album to switch to)/i,
    "Couldn't open that album. Try again.",
  ],
  [
    /^Failed to (read file|stage upload|store photo)|photos\.add|too large|too big/i,
    "Couldn't add that photo. Try again.",
  ],
  [/disk full/i, "This phone is out of space."],
  [/failed to fetch|^HTTP \d{3}/i, "Couldn't reach Justus on this phone. Reload and try again."],
  [/network|unreachable|timed? ?out/i, "Couldn't connect. Check your internet and try again."],
  [/^Internal error/i, "Something went wrong inside Justus."],
];

/** Messages the web layer already wrote for people; shown as they are. */
const ALREADY_FRIENDLY = new Set([
  "Enter a name to continue",
  "That invite doesn't look right. Check you copied all of it.",
]);

export function friendlyError(raw: string): string {
  if (ALREADY_FRIENDLY.has(raw)) return raw;
  for (const [pattern, text] of RULES) if (pattern.test(raw)) return text;
  return "Something went wrong. Try again.";
}
