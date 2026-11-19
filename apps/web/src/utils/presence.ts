/** A member's phone not reachable for this long reads as off on every screen; a shorter gap still reads as connected. */
export const OFF_AFTER_MS = 30_000;
/** How often the words move on while someone's phone is not connected. */
export const PRESENCE_TICK_MS = 15_000;

/** What the rule reads besides the member: the time now. */
export type PresenceClock = { now: number };

/** connected: connected now, or lost under 30 s ago.
 *  off: not reachable for 30 s or more, last seen at `lastSeenAt`.
 *  neverConnected: not reachable and never seen. */
export type PresenceKind = "connected" | "off" | "neverConnected";

/**
 * The one rule for "is this friend's phone on". Readers that keep the raw `connected` on purpose:
 * `reach-hint.ts` (WiFi hint, its own timers), `still-to-drop.ts` and `photo-wait.ts` (they count photos and do not word presence).
 */
export function presenceOf(
  m: { connected: boolean; lastSeenAt?: number },
  clock: PresenceClock,
): PresenceKind {
  if (m.connected) return "connected";
  const since = m.lastSeenAt;
  if (since === undefined) return "neverConnected";
  if (since <= clock.now && clock.now - since < OFF_AFTER_MS) return "connected";
  return "off";
}
