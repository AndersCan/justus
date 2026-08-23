import type { JoinRequest } from "@justus/core";

/**
 * Returns a copy of `requests` with the single request matching *both*
 * `folderId` and `requesterKey` removed.
 *
 * A requester may have pending join requests for several of this device's
 * folders. Responding to one must not drop the others (bug #45) — so the
 * identity is the (folderId, requesterKey) pair, not the requester alone.
 */
export function removeRequestFromList(
  requests: JoinRequest[],
  folderId: string,
  requesterKey: string,
): JoinRequest[] {
  return requests.filter((r) => !(r.folderId === folderId && r.requesterKey === requesterKey));
}
