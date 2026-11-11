import type { PhotoHolders, PhotoMember } from "@justus/core";

import { copy } from "../copy/copy";
import { nameList } from "./people";
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
            : h.waiting.length + h.previews.length > 0
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
  previews: PhotoMember[];
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
    previews: h?.previews ?? [],
    former: h?.former ?? [],
    left: h?.left ?? [],
  };
}

/** "Ben has the full photo." / "Ben and Cy have the full photo."; "" for no names. Sheet, dialog and toast share these words. */
export function hasFullPhoto(names: readonly string[]): string {
  return names.length === 0
    ? ""
    : copy("full_photo.names_have", { list: nameList(names), n: names.length });
}

/** "The photo no longer shows for Ben. The small preview already on their phone can't be wiped from here." (plural: "their phones"); "" for no names. */
export function previewOnly(names: readonly string[]): string {
  return names.length === 0
    ? ""
    : copy("full_photo.names_preview", { list: nameList(names), n: names.length });
}

/** "Cy doesn't have the full photo." / "Cy and Dan don't have the full photo."; "" for no names. */
export function lacksFullPhoto(names: readonly string[]): string {
  return names.length === 0
    ? ""
    : copy("full_photo.names_lack", { list: nameList(names), n: names.length });
}

/** The delete dialog's text: it leaves everyone's album, who has the full photo, and who does not. */
export function deleteDetail(h: PhotoHolders | undefined): string {
  const gone = copy("lightbox.it_will_be_gone_from");
  const have = (h?.others ?? []).map((m) => m.name);
  const preview = (h?.previews ?? []).map((m) => m.name);
  const lack = (h?.waiting ?? []).map((m) => m.name);
  const cannot =
    have.length === 0 ? "" : copy("lightbox.stops_showing_can_t_erase", { n: have.length });
  const back = copy("lightbox.deleting_can_t_take_back", { k: Math.max(1, have.length) });
  return [gone, hasFullPhoto(have), cannot, previewOnly(preview), lacksFullPhoto(lack), back]
    .filter((x) => x !== "")
    .join(" ");
}

/** The toast after a delete: which photo, who has the full photo, who does not, and who finds out when connected. */
export function deletedMessage(
  name: string,
  holders: PhotoHolders | undefined,
  people: readonly { key: string; name: string; connected: boolean }[],
): string {
  const named = (m: PhotoMember) => people.find((p) => p.key === m.key)?.name ?? m.name;
  const have = (holders?.others ?? []).map(named);
  const preview = (holders?.previews ?? []).map(named);
  const lack = (holders?.waiting ?? []).map(named);
  const later = [...(holders?.others ?? []), ...(holders?.previews ?? [])]
    .filter((m) => people.some((p) => p.key === m.key && !p.connected))
    .map(named);
  return [
    copy("lightbox.deleted", { name }),
    hasFullPhoto(have),
    previewOnly(preview),
    lacksFullPhoto(lack),
    later.length > 0 ? copy("lightbox.will_see_it_when_connected", { list: nameList(later) }) : "",
  ]
    .filter((x) => x !== "")
    .join(" ");
}
