import type { SyncStatus } from "@justus/core";

import { copy } from "../copy/copy";
/** How long every other member must stay unreachable before the hint shows. */
export const REACH_HINT_AFTER_MS = 30_000;

/**
 * Who we are failing to reach, or null when nothing needs saying: the album has
 * other members and none of them is connected. Returns the name to mention (the
 * Admin first, since a pending join waits on them), or "" when no name is known.
 * Time-based only; the app never tries to detect the network type.
 */
export function unreachableMember(status: SyncStatus | null): string | null {
  const others = (status?.members ?? []).slice(1);
  if (others.length === 0 || others.some((m) => m.connected)) return null;
  const target = others.find((m) => m.admin) ?? others[0];
  return target.name && target.name !== "Unknown device" ? target.name : "";
}

export function reachHintText(name: string): string {
  if (!name) return copy("reach_hint.can_t_reach_anyone_in");
  return copy("reach_hint.can_t_reach_if_you", { name });
}
