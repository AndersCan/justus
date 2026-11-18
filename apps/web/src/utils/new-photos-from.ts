/** Names shown while a phone's real name is not known yet. */
const PLACEHOLDER_NAMES: ReadonlySet<string> = new Set(["Unknown device", "New member"]);

/** `photos` are the new photos only. Names the adder when one named person added them all. */
export function newPhotosFrom(
  photos: readonly { member: { key: string; name: string } }[],
): { count: number; adder?: string } | null {
  const first = photos[0];
  if (first === undefined) return null;
  const adder = photos.every((p) => p.member.key === first.member.key)
    ? first.member.name.trim()
    : "";
  if (adder === "" || PLACEHOLDER_NAMES.has(adder)) return { count: photos.length };
  return { count: photos.length, adder };
}
