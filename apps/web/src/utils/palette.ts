/** Per-person colours: a seat number the Admin's phone wrote next to the person's name. */

// Kept clear of the brand indigo and coral, and of the green, amber and red that mean connection status.
const MEMBER_COLORS = ["#C2457A", "#155E75", "#2A73AA", "#8A5232", "#5E6B80"] as const;

/** The seat's colour; none for a person without a seat. */
export function memberColor(color: number | undefined): string | undefined {
  return color === undefined ? undefined : MEMBER_COLORS[color % MEMBER_COLORS.length];
}
