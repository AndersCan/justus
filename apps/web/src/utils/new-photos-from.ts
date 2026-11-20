/** Names shown while a phone's real name is not known yet. */
const PLACEHOLDER_NAMES: ReadonlySet<string> = new Set(["Unknown device", "New member"]);

const NAMED_MAX = 3;

/** One named person and how many of the new photos they added. */
export type NewFrom = { key: string; name: string; count: number };

/** Who added an album's new photos. `count` is all of them, so it equals the New marks. */
export type NewPhotosFrom = {
  count: number;
  /** Up to three named people, most photos first (ties by key). Empty when nobody has a name yet. */
  named: NewFrom[];
  /** Every new photo not counted in `named`, unnamed adders included. Only set when someone is named. */
  more?: number;
};

/** `photos` are the new photos only. */
export function newPhotosFrom(
  photos: readonly { member: { key: string; name: string } }[],
): NewPhotosFrom | null {
  if (photos.length === 0) return null;
  const byKey = new Map<string, NewFrom>();
  for (const { member } of photos) {
    const name = member.name.trim();
    if (name === "" || PLACEHOLDER_NAMES.has(name)) continue;
    const seen = byKey.get(member.key);
    if (seen === undefined) byKey.set(member.key, { key: member.key, name, count: 1 });
    else seen.count += 1;
  }
  const named = [...byKey.values()]
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, NAMED_MAX);
  if (named.length === 0) return { count: photos.length, named };
  const more = photos.length - named.reduce((sum, n) => sum + n.count, 0);
  return more > 0 ? { count: photos.length, named, more } : { count: photos.length, named };
}
