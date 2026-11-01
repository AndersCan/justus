/** Stable per-device colors, derived from a device's drive key. */

// Kept clear of the brand indigo and coral.
const MEMBER_COLORS = ["#C2457A", "#3A8A4C", "#2F7DB8", "#A8700F", "#5E6B80"] as const;

function hashOf(key: string): number {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

/** Same device always maps to the same color. */
export function memberColor(key: string): string {
  return MEMBER_COLORS[hashOf(key) % MEMBER_COLORS.length];
}
