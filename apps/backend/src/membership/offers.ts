import type { OfferSummary } from "@justus/core";

/** The Admin waits this long for a friend's phone to confirm an invite. */
export const OFFER_REACH_MS = 30_000;
/** The Admin resends the invite this often while waiting (the receiver is idempotent). */
export const OFFER_RESEND_MS = 2_000;

/** `offers` with `incoming` added; an invite with the same code and Admin replaces the old one. */
export function holdOffer(offers: OfferSummary[], incoming: OfferSummary): OfferSummary[] {
  const rest = offers.filter((o) => !(o.code === incoming.code && o.owner === incoming.owner));
  return [...rest, incoming];
}

/** True when a phone may show an invite from `sender`: a friend, or someone it already shares an album with. */
export function mayShowOfferFrom(
  sender: string,
  known: { isFriend: boolean; coMembers: Set<string>; albumAdmins: Set<string> },
): boolean {
  return known.isFriend || known.coMembers.has(sender) || known.albumAdmins.has(sender);
}
