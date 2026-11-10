import type { Photo } from "@justus/core";
import { copy } from "../copy/copy";

/** What one person's phone holds of an album, as it last told this one. */
export type Holding = { kind: "count"; held: number } | { kind: "silent" };

export type AlbumHolding = {
  /** Album photos whose holders are known. 0 means: say nothing. */
  total: number;
  /** By person key (current people other than this phone). An absent key holds 0 of `total`. */
  byKey: ReadonlyMap<string, Holding>;
};

/** Counts, per person, how many of an album's photos their phone holds. */
export function albumHolding(photos: readonly Photo[], folderId: string): AlbumHolding {
  const byKey = new Map<string, Holding>();
  let total = 0;
  for (const photo of photos) {
    const holders = photo.holders;
    if (photo.folderId !== folderId || holders === undefined) continue;
    total += 1;
    for (const m of holders.others) {
      const prev = byKey.get(m.key);
      if (prev?.kind === "silent") continue;
      byKey.set(m.key, { kind: "count", held: (prev?.held ?? 0) + 1 });
    }
    for (const m of holders.unsure) byKey.set(m.key, { kind: "silent" });
  }
  return { total, byKey };
}

/** The line under another person, or undefined when there is nothing to say (total 0). Your own row has no line. */
export function holdingLine(h: Holding | undefined, total: number): string | undefined {
  if (total === 0) return undefined;
  if (h?.kind === "silent") return copy("holding.silent");
  const held = h?.held ?? 0;
  if (held === 0) return copy("holding.none");
  return held >= total ? copy("holding.all") : copy("holding.some");
}
