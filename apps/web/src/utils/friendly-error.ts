import { copy } from "../copy/copy"; /**
 * Turns an error message from an actor (often a raw backend or transport
 * string, e.g. "Share key must be a 64-char hex key") into a sentence a
 * non-technical user can act on. Code words (key, hex, creator, reader,
 * drive) never reach the screen; the raw text stays available for the
 * diagnostics log and as the banner's tooltip.
 */

const RULES: [RegExp, string][] = [
  [/^Share key must be/i, copy("error.that_invite_link_doesn_t")],
  [/^(Drive|Member|Requester) key must be/i, copy("error.that_drive_key_doesn_t")],
  [/^You already own this album/i, copy("error.you_started_this_album_so")],
  [/Readers cannot add photos/i, copy("error.you_can_t_add_photos")],
  [/^Only the (creator|Admin)|not the Admin/i, copy("error.only_the_admin_who_started")],
  [/^Member already enrolled/i, copy("error.they_can_already_add_photos")],
  [/^You cannot enroll yourself/i, copy("error.that_is_this_phone_s")],
  [/^No such member|no member to remove/i, copy("error.that_person_isn_t_in")],
  [
    /^(Album name|Name) is required|no album name|no name given/i,
    copy("error.enter_a_name_to_continue"),
  ],
  [/timeout opening remote drive/i, copy("error.couldn_t_find_the_album")],
  [
    /^(Cannot open album|No album|No album is active|no album to switch to)/i,
    copy("error.couldn_t_open_that_album"),
  ],
  [
    /^Failed to (read file|stage upload|store photo)|photos\.add|too large|too big/i,
    copy("error.couldn_t_add_that_photo"),
  ],
  [/disk full/i, copy("error.this_phone_is_out_of")],
  [/failed to fetch|^HTTP \d{3}/i, copy("error.couldn_t_reach_justus_on")],
  [/network|unreachable|timed? ?out/i, copy("error.couldn_t_connect_check_your")],
  [/^Update Justus to open your albums/i, copy("error.update_justus_to_open_your")],
  [/^Internal error/i, copy("error.something_went_wrong_inside_justus")],
];

/** Messages the web layer already wrote for people; shown as they are. */
const ALREADY_FRIENDLY = new Set([
  copy("error.enter_a_name_to_continue_2"),
  copy("error.that_invite_doesn_t_look"),
]);

export function friendlyError(raw: string): string {
  if (ALREADY_FRIENDLY.has(raw)) return raw;
  for (const [pattern, text] of RULES) if (pattern.test(raw)) return text;
  return copy("error.something_went_wrong_try_again");
}
