/** Stable per-device warm colors, derived from a device's drive key. */

const MEMBER_COLORS = ["#B05C2E", "#6E7F45", "#7C5A88", "#C98A2D"] as const;

function hashOf(key: string): number {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

/** Same device always maps to the same warm color. */
export function memberColor(key: string): string {
  return MEMBER_COLORS[hashOf(key) % MEMBER_COLORS.length];
}
