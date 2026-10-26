/** Up to two uppercase initials from a display name ("?" when empty). */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const chars = (w: string) => Array.from(w);
  const letters =
    words.length === 1 ? chars(words[0]).slice(0, 2) : words.slice(0, 2).map((w) => chars(w)[0]);
  return letters.join("").toUpperCase();
}

/** A stable hue (0–359) derived from the name, so a member keeps one colour. */
export function hueOf(name: string): number {
  let h = 0;
  for (const ch of name.trim().toLowerCase()) h = (h * 31 + ch.codePointAt(0)!) % 360;
  return h;
}

/** Background colour for the avatar; dark enough for white initials. */
export function avatarColor(name: string): string {
  return `hsl(${hueOf(name)} 55% 40%)`;
}
