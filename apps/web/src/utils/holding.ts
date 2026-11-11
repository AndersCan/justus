import type { Photo } from "@justus/core";
import { copy } from "../copy/copy";
import { holdersSheetRows } from "./holders";

/** What one person's phone holds of an album, as it last told this one. */
export type Holding = { kind: "count"; held: number } | { kind: "silent" } | { kind: "previews" };

export type AlbumHolding = {
  /** Album photos whose holders are known. 0 means: say nothing. */
  total: number;
  /** By person key (current people other than this phone). An absent key holds 0 of `total`. */
  byKey: ReadonlyMap<string, Holding>;
};

/** Per person: on how many of the album's photos the holders sheet lists them under "Has the full photo".
 * Silent only when no sheet lists them there and some sheet lists them as not said yet. */
export function albumHolding(photos: readonly Photo[], folderId: string): AlbumHolding {
  const held = new Map<string, number>();
  const unsure = new Set<string>();
  const previewing = new Set<string>();
  let total = 0;
  for (const photo of photos) {
    if (photo.folderId !== folderId || photo.holders === undefined) continue;
    total += 1;
    const rows = holdersSheetRows(photo.holders);
    for (const m of rows.others) held.set(m.key, (held.get(m.key) ?? 0) + 1);
    for (const m of rows.unsure) unsure.add(m.key);
    for (const m of photo.holders.previews) previewing.add(m.key);
  }
  const byKey = new Map<string, Holding>();
  for (const key of previewing) byKey.set(key, { kind: "previews" });
  for (const key of unsure) byKey.set(key, { kind: "silent" });
  for (const [key, n] of held) byKey.set(key, { kind: "count", held: n });
  return { total, byKey };
}

/** The phone part of another person's member line, or undefined when there is nothing to say (total 0). Your own row has none. */
export function holdingLine(h: Holding | undefined, total: number): string | undefined {
  if (total === 0) return undefined;
  const held = h?.kind === "count" ? h.held : 0;
  if (held > 0) return held >= total ? copy("holding.all") : copy("holding.some", { n: held });
  if (h?.kind === "silent") return copy("holding.silent");
  return h?.kind === "previews" ? copy("holding.none") : copy("holding.nothing");
}
