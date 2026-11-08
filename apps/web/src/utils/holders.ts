import type { PhotoHolders, PhotoMember } from "@justus/core";

import { copy } from "../copy/copy";
/** Longest text the one-line "who has it" row shows before it falls back to a count. */
const LIMIT = 36;

/** The one line on photo detail that says whose phones have a full copy. */
export function holdersLine(h: PhotoHolders | undefined): { text: string; tappable: boolean } {
  if (!h) return { text: copy("holders.can_t_tell_who_has"), tappable: false };
  const k = h.others.length + h.former.length;
  const names = h.others.map((m) => `${m.name}'s`);
  const named = h.former.length === 0 && names.length >= 1 && names.length <= 3;
  if (h.here) {
    if (k === 0) {
      return {
        text:
          h.unsure.length > 0
            ? copy("holders.on_your_phone_others_haven")
            : h.waiting.length > 0
              ? copy("holders.only_on_your_phone_so")
              : copy("holders.only_on_your_phone"),
        tappable: true,
      };
    }
    if (named) {
      const text = copy("holders.on_and_your_phone", { names: names.join(", ") });
      if (text.length <= LIMIT) return { text, tappable: true };
    }
    return { text: copy("holders.on_your_phone_and", { k }), tappable: true };
  }
  if (k === 0) return { text: copy("holders.arriving_on_your_phone"), tappable: true };
  if (named && names.length === 1) {
    const text = copy("holders.on_phone_arriving_on_yours", { name: names[0] });
    if (text.length <= LIMIT) return { text, tappable: true };
  }
  return {
    text: copy("holders.on_arriving_on_yours", { k }),
    tappable: true,
  };
}

export type HoldersSheetRows = {
  /** True when this phone is still waiting for its copy. */
  youArriving: boolean;
  others: PhotoMember[];
  unsure: PhotoMember[];
  waiting: PhotoMember[];
  former: string[];
  left: string[];
};

/** What the "Who has this photo" sheet lists; empty sections are left out by the view. */
export function holdersSheetRows(h: PhotoHolders | undefined): HoldersSheetRows {
  return {
    youArriving: !h?.here,
    others: h?.others ?? [],
    unsure: h?.unsure ?? [],
    waiting: h?.waiting ?? [],
    former: h?.former ?? [],
    left: h?.left ?? [],
  };
}

/** The delete dialog's text: who loses the photo, and whose phones keep a copy. */
export function deleteDetail(h: PhotoHolders | undefined): string {
  const gone = copy("lightbox.it_will_be_gone_from");
  const names = (h?.others ?? []).map((m) => `${m.name}'s`);
  if (names.length === 0) return gone;
  const keeps =
    names.length === 1
      ? copy("lightbox.phone_keeps_a_copy", { name: names[0] })
      : copy("lightbox.and_phones_keep_a_copy", {
          names: names.slice(0, -1).join(", "),
          last: names[names.length - 1],
        });
  return `${gone} ${keeps} ${copy("lightbox.deleting_can_t_take_back", { k: names.length })}`;
}
