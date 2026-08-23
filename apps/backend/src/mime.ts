/**
 * Canonical extension → MIME map shared by the production photo-store and the
 * pure gallery derivation (issue #48).
 *
 * There used to be two copies of this table — `photo-store.guessMime` (the code
 * the app actually serves) and `gallery-order.guessMimeFor` — which silently
 * diverged the moment anyone edited one and not the other. This module is the
 * single source of truth both paths delegate to, so the served gallery and the
 * tested derivation can never disagree on a photo's type again.
 */
export const EXT_MIME: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
};

export const DEFAULT_MIME = "image/jpeg";

/** Resolve an extension (with or without leading dot, any case) to a MIME type. */
export function guessMime(ext: string): string {
  return EXT_MIME[ext.toLowerCase()] ?? DEFAULT_MIME;
}
