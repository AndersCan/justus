import type { PhotoHolders, PhotoMember, QuietHolder } from "@justus/core";

import { copy } from "../copy/copy";
import { nameKey, nameList } from "./people";
import { formatDay } from "./time";
/** Longest text the one-line "who has it" row shows before it falls back to a count. */
const LIMIT = 36;

/** The one line on photo detail that says whose phones have a full copy, and whose have the preview. */
export function holdersLine(
  h: PhotoHolders | undefined,
  now = Date.now(),
): { text: string; tappable: boolean } {
  const line = baseLine(h);
  if (h?.kind !== "inAlbum") return line;
  const preview = h.here ? previewClause(h.previews) : "";
  if (preview === "" && h.quiet.length === 0) return line;
  let text =
    h.here && h.others.length + h.former.length === 0 && (preview !== "" || h.quiet.length > 0)
      ? copy("holders.on_your_phone")
      : line.text;
  if (preview !== "") text = copy("holders.line_and_preview", { line: text, preview });
  if (h.quiet.length > 0) {
    const quiet = h.quiet
      .map((m) =>
        copy("holders.quiet_one_when", { name: `${m.name}'s`, when: formatDay(m.lastSeenAt, now) }),
      )
      .join(", ");
    text = copy("holders.line_and_quiet", { line: text, quiet });
  }
  return { text, tappable: true };
}

/** "Preview on Ben's phone", or "Preview on 4 phones" when the names are many, alike or long. */
function previewClause(previews: readonly PhotoMember[]): string {
  if (previews.length === 0) return "";
  const names = previews.map((m) => `${m.name}'s`);
  const distinct = new Set(previews.map((m) => nameKey(m.name))).size === previews.length;
  if (names.length <= 3 && distinct) {
    const text = copy("holders.preview_on_names", { names: nameList(names), n: names.length });
    if (text.length <= LIMIT) return text;
  }
  return copy("holders.preview_on_names", { names: String(previews.length), n: previews.length });
}

function baseLine(h: PhotoHolders | undefined): { text: string; tappable: boolean } {
  if (!h) return { text: copy("holders.can_t_tell_who_has"), tappable: false };
  if (h.kind === "removed") {
    return {
      text: h.here ? copy("holders.on_your_phone_removed") : copy("holders.arriving_on_your_phone"),
      tappable: true,
    };
  }
  const k = h.others.length + h.former.length;
  const names = h.others.map((m) => `${m.name}'s`);
  const distinct = new Set(h.others.map((m) => nameKey(m.name))).size === h.others.length;
  const named = h.former.length === 0 && names.length >= 1 && names.length <= 3 && distinct;
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
    if (h.others.length === 0 && h.former.length === 1) {
      return {
        text: copy("holders.on_your_phone_name_removed", { name: h.former[0] }),
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
  quiet: QuietHolder[];
  unsure: PhotoMember[];
  waiting: PhotoMember[];
  previews: PhotoMember[];
  former: string[];
  left: string[];
};

/** What the "Who has this photo" sheet lists; empty sections are left out by the view. */
export function holdersSheetRows(h: PhotoHolders | undefined): HoldersSheetRows {
  if (h?.kind === "removed") {
    return {
      youArriving: !h.here,
      others: [],
      quiet: [],
      unsure: [],
      waiting: [],
      previews: [],
      former: [],
      left: [],
    };
  }
  return {
    youArriving: !h?.here,
    others: h?.others ?? [],
    quiet: h?.quiet ?? [],
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

/** "The photo no longer shows for Ben."; "" for no names. */
export function previewOnly(names: readonly string[]): string {
  return names.length === 0 ? "" : copy("full_photo.names_preview", { list: nameList(names) });
}

/** "Cy doesn't have the full photo." / "Cy and Dan don't have the full photo."; "" for no names. */
export function lacksFullPhoto(names: readonly string[]): string {
  return names.length === 0
    ? ""
    : copy("full_photo.names_lack", { list: nameList(names), n: names.length });
}

/** "Ben's phone stops showing it and drops its copy once it's connected."; "" for no names. */
function dropsCopy(names: readonly string[]): string {
  return names.length === 0
    ? ""
    : copy("lightbox.phones_drop_copy", {
        list: nameList(names.map((n) => `${n}'s`)),
        n: names.length,
      });
}

/** "Ben was removed and keeps a copy on their phone."; "" unless exactly one removed person. */
function removedKeeps(names: readonly string[]): string {
  return names.length === 1 ? copy("full_photo.name_removed_keeps", { name: names[0] }) : "";
}

/** The delete dialog's text: it leaves everyone's album, who still has it and drops it, who has no full photo, and who was removed but keeps a copy. */
export function deleteDetail(h: PhotoHolders | undefined): string {
  const gone = copy("lightbox.it_will_be_gone_from");
  const live = h?.kind === "inAlbum" ? h : undefined;
  const phones = [...(live?.others ?? []), ...(live?.quiet ?? []), ...(live?.previews ?? [])].map(
    (m) => m.name,
  );
  const lack = (live?.waiting ?? []).map((m) => m.name);
  const back = copy("lightbox.deleting_can_t_take_back");
  return [gone, dropsCopy(phones), removedKeeps(live?.former ?? []), lacksFullPhoto(lack), back]
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
  const live = holders?.kind === "inAlbum" ? holders : undefined;
  const have = [...(live?.others ?? []), ...(live?.quiet ?? [])].map(named);
  const preview = (live?.previews ?? []).map(named);
  const lack = (live?.waiting ?? []).map(named);
  const later = [...(live?.others ?? []), ...(live?.quiet ?? []), ...(live?.previews ?? [])]
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
