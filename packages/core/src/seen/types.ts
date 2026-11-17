/** What this phone has looked at. Kept in the app's own storage; never sent to another phone. */
export type SeenRecord = {
  version: 1;
  /** The album whose photo page was opened last on this phone. Unset before any, or after it was gone at a start. */
  lastAlbum?: string;
  /** Per album id: ids of the photos this phone knows (listed when the album first had photos here, or looked at since). */
  known: Record<string, string[]>;
};

export const SEEN_VERSION = 1;

export const SeenError = {
  UNSUPPORTED_VERSION: "justus.seen/unsupported-version",
  INVALID: "justus.seen/invalid",
  WRITE_FAILED: "justus.seen/write-failed",
} as const;

export const emptySeen = (): SeenRecord => ({ version: 1, known: {} });

/** The record as stored and sent; undefined for anything else (wrong version, wrong shape). Drops non-string ids. */
export function parseSeen(value: unknown): SeenRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  if (!("version" in value) || value.version !== SEEN_VERSION) return undefined;
  const known: Record<string, string[]> = {};
  const rawKnown = "known" in value ? value.known : undefined;
  if (typeof rawKnown !== "object" || rawKnown === null || Array.isArray(rawKnown)) {
    return undefined;
  }
  for (const [album, ids] of Object.entries(rawKnown)) {
    if (!Array.isArray(ids)) return undefined;
    known[album] = ids.filter((id): id is string => typeof id === "string");
  }
  const lastAlbum = "lastAlbum" in value ? value.lastAlbum : undefined;
  if (typeof lastAlbum === "string") return { version: SEEN_VERSION, lastAlbum, known };
  return { version: SEEN_VERSION, known };
}
