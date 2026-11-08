import type { PhotoHolders, PhotoMember } from "@justus/core";

/** Longest text the one-line "who has it" row shows before it falls back to a count. */
const LIMIT = 36;

/** The one line on photo detail that says whose phones have a full copy. */
export function holdersLine(h: PhotoHolders | undefined): { text: string; tappable: boolean } {
  if (!h) return { text: "Can't tell who has this photo yet", tappable: false };
  const k = h.others.length + h.former.length;
  const names = h.others.map((m) => `${m.name}'s`);
  const named = h.former.length === 0 && names.length >= 1 && names.length <= 3;
  if (h.here) {
    if (k === 0) {
      return {
        text: h.unsure.length === 0 ? "Only on your phone" : "On your phone. Others haven't said",
        tappable: true,
      };
    }
    if (named) {
      const text = `On ${names.join(", ")} and your phone`;
      if (text.length <= LIMIT) return { text, tappable: true };
    }
    return { text: `On your phone and ${k} ${k === 1 ? "other" : "others"}`, tappable: true };
  }
  if (k === 0) return { text: "Arriving on your phone…", tappable: true };
  if (named && names.length === 1) {
    const text = `On ${names[0]} phone. Arriving on yours…`;
    if (text.length <= LIMIT) return { text, tappable: true };
  }
  return {
    text: `On ${k} ${k === 1 ? "phone" : "phones"}. Arriving on yours…`,
    tappable: true,
  };
}

export type HoldersSheetRows = {
  /** True when this phone is still waiting for its copy. */
  youArriving: boolean;
  others: PhotoMember[];
  unsure: PhotoMember[];
  former: string[];
};

/** What the "Who has this photo" sheet lists; empty sections are left out by the view. */
export function holdersSheetRows(h: PhotoHolders | undefined): HoldersSheetRows {
  return {
    youArriving: !h?.here,
    others: h?.others ?? [],
    unsure: h?.unsure ?? [],
    former: h?.former ?? [],
  };
}
