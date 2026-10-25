/** Stable per-device colors, derived from a device's drive key. */

const MEMBER_COLORS = ["#E5733F", "#4FA36B", "#8E6FD1", "#D9A33A", "#3F95D9"] as const;

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
