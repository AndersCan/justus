/** Pure derivation of the p2p connection indicator's tone + label.
 *
 * justus is peer-to-peer by construction, so the privacy half of the message
 * ("no server") is constant; what varies is whether this device currently has
 * a direct peer. The vision reserves green/amber/red for connection state
 * only, so this module is the single source of truth for that mapping.
 *
 * Kept free of any framework/bare imports so it can be unit-tested under the
 * node test runner (the web machines' glue must not pull the Bare gateway).
 */

export type ConnectionTone = "green" | "amber" | "red";

/** Green = at least one direct peer; amber = direct but no peers yet;
 * red = the sync machine is dead and a reload is required. */
export function connectionTone(peers: number, fatal: boolean): ConnectionTone {
  if (fatal) return "red";
  return peers > 0 ? "green" : "amber";
}

/** Human-readable label: always leads with "direct" to keep the p2p model
 * legible, and appends the live peer count when connected. */
export function connectionLabel(peers: number, fatal: boolean): string {
  if (fatal) return "sync stopped";
  return peers > 0 ? `direct · ${peers} peer${peers === 1 ? "" : "s"}` : "direct · no peers yet";
}
