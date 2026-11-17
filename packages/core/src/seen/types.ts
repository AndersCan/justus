/** What this phone has looked at. Kept in the app's own storage; never sent to another phone. */
export type SeenRecord = {
  version: 1;
  /** The album whose photo page was opened last on this phone. Unset before any, or after it was gone at a start. */
  lastAlbum?: string;
  /** Per album id: ids of the photos this phone knows (listed when the album first had photos here, or looked at since). */
  known: Record<string, string[]>;
};

export const SEEN_VERSION = 1;

export const emptySeen = (): SeenRecord => ({ version: 1, known: {} });
