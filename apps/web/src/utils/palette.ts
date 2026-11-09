/** Per-person colours: a seat number the Admin's phone wrote next to the person's name. */

// Kept clear of the brand indigo and coral, and of the green, amber and red that mean connection status:
// blue and slate, never teal or olive.
const MEMBER_COLORS = ["#C2457A", "#2672C0", "#9A583C", "#7B4FC4", "#5E7288"] as const;

/** The seat's colour; none for a person without a seat. */
export function memberColor(color: number | undefined): string | undefined {
  return color === undefined ? undefined : MEMBER_COLORS[color % MEMBER_COLORS.length];
}
