import type { Photo, PhotoMember, SyncMember } from "@justus/core";

/** What the album page says about previews on their way. A part is unset when it would say nothing. */
export type PhotoWait = {
  /** Photos whose preview this phone lacks while a phone that has them is connected. */
  coming?: number;
  /** Photos this phone has that at least one member's phone said it lacks, and how many phones lack some. */
  waitsFor?: { count: number; phones: PhotoMember[] };
};

/** `photos` are one album's; `members` its status members. */
export function photoWait(
  photos: readonly Photo[],
  members: readonly Pick<SyncMember, "key" | "connected">[],
): PhotoWait {
  const connected = new Set(members.filter((m) => m.connected).map((m) => m.key));
  let coming = 0;
  let waiting = 0;
  const phones = new Map<string, PhotoMember>();
  for (const photo of photos) {
    const holders = photo.holders;
    if (photo.thumbUrl === undefined || holders === undefined || holders.kind !== "inAlbum")
      continue;
    if (!holders.here && !holders.previewHere) {
      const sources = [photo.member, ...holders.others, ...holders.previews];
      if (sources.some((s) => connected.has(s.key))) coming++;
    } else if (holders.waiting.length > 0) {
      waiting++;
      for (const m of holders.waiting) phones.set(m.key, m);
    }
  }
  return {
    ...(coming > 0 ? { coming } : {}),
    ...(waiting > 0
      ? {
          waitsFor: {
            count: waiting,
            phones: [...phones.values()].sort(
              (a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key),
            ),
          },
        }
      : {}),
  };
}
