/** Per-person colours: a seat number the Admin's phone wrote next to the person's name. */

// Kept clear of the brand indigo and coral, and of the green, amber and red that mean connection status:
// 30 degrees of hue from each status colour, so only blues, violets and magentas: never teal, olive, brown or red-pink.
const MEMBER_COLORS = ["#B0408C", "#2672C0", "#9A3AF0", "#7B4FC4", "#5E7288"] as const;

/** The seat's colour; none for a person without a seat. */
export function memberColor(color: number | undefined): string | undefined {
  return color === undefined ? undefined : MEMBER_COLORS[color % MEMBER_COLORS.length];
}
