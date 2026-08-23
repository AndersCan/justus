import type { Photo } from "@justus/core";

/**
 * I3 canonical gallery order: (addedAt desc, memberKey asc, id asc).
 *
 * A pure function of record data — no clock, no environment — so the derived
 * gallery is byte-identical on every replica (issue #23, invariant I3).
 * Ties on addedAt are common across devices (same-ms captures, batch
 * replication), which makes the memberKey/id tie-breakers load-bearing:
 * without them Array#sort stability would differ between replicas that
 * received the same entries in different orders.
 */
export function compareGalleryOrder(a: Photo, b: Photo): number {
  if (a.addedAt !== b.addedAt) return b.addedAt - a.addedAt;
  const byMember = a.member.key < b.member.key ? -1 : a.member.key > b.member.key ? 1 : 0;
  if (byMember !== 0) return byMember;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
