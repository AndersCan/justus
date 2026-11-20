import type { HolderMember, Photo, PhotoHolders, PhotoMember, QuietHolder } from "@justus/core";

import { copy } from "../copy/copy";
import { nameKey, nameList, shownName } from "./people";
import { presenceOf } from "./presence";
import { formatDay } from "./time";
/** Longest text the one-line "who has it" row shows before it falls back to a count. */
const LIMIT = 36;

/** The one line on photo detail that says whose phones have a full copy, whose have the preview, and whose are still to get it. `now` ages friends' phones with the same rule Members uses. */
export function holdersLine(
  h: PhotoHolders | undefined,
  now: number,
): { text: string; tappable: boolean } {
  const line = baseLine(h);
  if (h?.kind !== "inAlbum") return line;
  const preview = h.here ? previewClause(h.previews) : "";
  const reached = h.here ? h.waiting.filter((m) => presenceOf(m, { now }) === "connected") : [];
  const away = h.here ? h.waiting.filter((m) => presenceOf(m, { now }) !== "connected") : [];
  const onItsWay = reached.length > 0 ? onItsWayClause(reached) : "";
  const waitingFor = away.length > 0 ? waitingForClause(away) : "";
  const unsaid = h.unsure.length > 0;
  let text =
    h.here &&
    h.others.length + h.former.length === 0 &&
    (preview !== "" || h.quiet.length > 0 || ((onItsWay !== "" || waitingFor !== "") && !unsaid))
      ? copy("holders.on_your_phone")
      : line.text;
  if (preview !== "") text = copy("holders.line_and_preview", { line: text, preview });
  if (onItsWay !== "") text = copy("holders.line_and_waiting", { line: text, waiting: onItsWay });
  if (waitingFor !== "")
    text = copy("holders.line_and_waiting", { line: text, waiting: waitingFor });
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

/** `say` words the clause for some names and a count, such as "Preview on Ben's phone"; the names give way to a count when they are many, alike or long. */
function phonesClause(
  members: readonly PhotoMember[],
  say: (names: string, n: number) => string,
): string {
  const names = members.map((m) => `${m.name}'s`);
  const distinct = new Set(members.map((m) => nameKey(m.name))).size === members.length;
  if (names.length <= 3 && distinct) {
    const text = say(nameList(names), names.length);
    if (text.length <= LIMIT) return text;
  }
  return say(String(members.length), members.length);
}

/** "Preview on Ben's phone", or "Preview on 4 phones". */
function previewClause(previews: readonly PhotoMember[]): string {
  if (previews.length === 0) return "";
  return phonesClause(previews, (names, n) => copy("holders.preview_on_names", { names, n }));
}

/** "On its way to Ben's phone", or "On its way to 4 phones". */
function onItsWayClause(members: readonly PhotoMember[]): string {
  return phonesClause(members, (names, n) => copy("holders.on_its_way_to_names", { names, n }));
}

/** "Waiting for Ben's phone", or "Waiting for 4 phones": friends whose phones are off. */
function waitingForClause(members: readonly PhotoMember[]): string {
  return phonesClause(members, (names, n) => copy("holders.waiting_for_names", { names, n }));
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
  others: HolderMember[];
  quiet: QuietHolder[];
  unsure: HolderMember[];
  waiting: HolderMember[];
  previews: HolderMember[];
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

/** The toast after a delete: which photo, who has the full photo, who does not, and who finds out when connected. Reads only the photo's own people. */
export function deletedMessage(
  name: string,
  holders: PhotoHolders | undefined,
  friends: Readonly<Record<string, string>>,
  now: number,
): string {
  const named = (m: HolderMember) => shownName(m, friends);
  const live = holders?.kind === "inAlbum" ? holders : undefined;
  const have = [...(live?.others ?? []), ...(live?.quiet ?? [])].map(named);
  const preview = (live?.previews ?? []).map(named);
  const lack = (live?.waiting ?? []).map(named);
  const later = [...(live?.others ?? []), ...(live?.quiet ?? []), ...(live?.previews ?? [])]
    .filter((m) => presenceOf(m, { now }) !== "connected")
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

/** How many of an album's photos one member's phone holds in full and as previews. */
export type MemberHolding = { full: number; previews: number; waiting: number; total: number };

/** Each member's holding of `photos` (one album's), by member key, from the lists the photo sheet shows. A member on no list, or on `unsure` or `quiet`, is left out; so is everyone when there are no photos or any photo's holders are unknown. */
export function memberHoldings(
  photos: readonly Photo[],
  people: readonly { key: string; you: boolean }[],
): Map<string, MemberHolding> {
  const out = new Map<string, MemberHolding>();
  const lists = photos.flatMap((p) => (p.holders?.kind === "inAlbum" ? [p.holders] : []));
  if (photos.length === 0 || lists.length < photos.length) return out;
  const has = (ms: readonly PhotoMember[], key: string) => ms.some((m) => m.key === key);
  for (const { key, you } of people) {
    let full = 0;
    let previews = 0;
    let waiting = 0;
    let said = true;
    for (const h of lists) {
      if (you ? h.here : has(h.others, key)) full++;
      else if (you ? h.previewHere : has(h.previews, key)) previews++;
      else if (has(h.waiting, key)) waiting++;
      else if (!you) said = false;
    }
    if (said) out.set(key, { full, previews, waiting, total: lists.length });
  }
  return out;
}

/** The Members row line: "1 in full, 2 previews, 1 waiting"; zero parts left out; "" for no line. */
export function memberPhotosLine(h: MemberHolding | undefined): string {
  if (h === undefined) return "";
  return [
    h.full === 0 ? "" : copy("members.n_in_full", { n: h.full }),
    h.previews === 0 ? "" : copy("members.n_previews", { n: h.previews }),
    h.waiting === 0 ? "" : copy("members.n_waiting", { n: h.waiting }),
  ]
    .filter((p) => p !== "")
    .join(", ");
}

/** Who holds a set of photos (the ones a person who goes added): other people's keys with a full copy or preview (quiet ones too), and how many photos no other phone has. Unknown when any photo's list is not known yet. */
export type LeaverHolders =
  | { kind: "unknown" }
  | { kind: "known"; keys: ReadonlySet<string>; sole: number };

export function leaverHolders(mine: readonly Photo[]): LeaverHolders {
  const keys = new Set<string>();
  let sole = 0;
  for (const p of mine) {
    const h = p.holders;
    if (h?.kind !== "inAlbum") return { kind: "unknown" };
    for (const m of [...h.others, ...h.quiet, ...h.previews]) keys.add(m.key);
    if (
      h.others.length + h.quiet.length + h.previews.length + h.former.length + h.unsure.length ===
      0
    )
      sole += 1;
  }
  return { kind: "known", keys, sole };
}

/** How many of the album photos someone else added `key`'s phone has in full (others or quiet), as their phone last said: this phone's and other members'. A preview is not counted: it does not stay on a removed phone. Unknown while any photo's list is unknown, or `key` has not said for one. */
export type MemberKeeps = { kind: "unknown" } | { kind: "known"; yours: number; others: number };

export function memberKeeps(photos: readonly Photo[], key: string): MemberKeeps {
  let yours = 0;
  let others = 0;
  let unknown = false;
  for (const p of photos) {
    const h = p.holders;
    if (h?.kind !== "inAlbum") return { kind: "unknown" };
    if (p.member?.key === key) continue;
    const has = (ms: readonly PhotoMember[]) => ms.some((m) => m.key === key);
    if (has(h.others) || has(h.quiet)) {
      if (p.mine) yours += 1;
      else others += 1;
    } else if (!has(h.previews) && !has(h.waiting)) unknown = true;
  }
  return unknown ? { kind: "unknown" } : { kind: "known", yours, others };
}
