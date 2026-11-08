/** Peer protocol number sent on `justus/version`. Apps before it count as 1.
 * Raise it with every change to a file on a drive (see BREAKING.md). */
export const PEER_PROTOCOL = 4;

/** `justus.json` format. A file without `version` is 1. */
export const STATE_VERSION = 2;

export function stateVersionOf(parsed: unknown): number {
  if (typeof parsed !== "object" || parsed === null) return 1;
  const v = (parsed as { version?: unknown }).version;
  return typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : 1;
}
