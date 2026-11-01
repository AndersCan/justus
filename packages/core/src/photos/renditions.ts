/**
 * The copies of a photo an album shares. The device that adds a photo makes
 * them; the original never leaves that device. The native hosts mirror these
 * numbers (`MainActivity.kt`, `MediaHostPlugins.swift`).
 */

/** Long edge of the display copy: what a member sees when they open a photo. */
export const DISPLAY_EDGE = 2560;

/** Long edge of the thumbnail the grid shows. */
export const THUMB_EDGE = 640;

/** Every shared copy is a JPEG: every host encodes it and every Web layer
 * shows it. */
export const RENDITION_EXT = ".jpg";

export function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/** Scale `width`×`height` so the long edge is at most `edge`. Never upscales. */
export function fitWithin(
  width: number,
  height: number,
  edge: number,
): { width: number; height: number } {
  const scale = Math.min(1, edge / Math.max(width, height, 1));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}
