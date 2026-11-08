import type { OfferSummary } from "@justus/core";

/** The Admin waits this long for a friend's phone to confirm an invite. */
export const OFFER_REACH_MS = 30_000;
/** The Admin resends the invite this often while waiting (the receiver is idempotent). */
export const OFFER_RESEND_MS = 2_000;

/** A phone holds at most this many invites from one sender; the oldest are dropped. */
export const MAX_OFFERS_PER_SENDER = 20;

/** `offers` with `incoming` added; an invite with the same code and Admin replaces the old one. */
export function holdOffer(offers: OfferSummary[], incoming: OfferSummary): OfferSummary[] {
  const rest = offers.filter((o) => !(o.code === incoming.code && o.owner === incoming.owner));
  const fromSender = rest.filter((o) => o.owner === incoming.owner);
  const drop = new Set(
    fromSender.slice(0, Math.max(0, fromSender.length - MAX_OFFERS_PER_SENDER + 1)),
  );
  return [...rest.filter((o) => !drop.has(o)), incoming];
}

/** True when a phone may show an invite from `sender`: a friend, or someone it already shares an album with. */
export function mayShowOfferFrom(
  sender: string,
  known: { isFriend: boolean; coMembers: Set<string>; albumAdmins: Set<string> },
): boolean {
  return known.isFriend || known.coMembers.has(sender) || known.albumAdmins.has(sender);
}

/** A friend invite nobody answered waits this long on the Admin's phone. */
export const OFFER_HOLD_MS = 7 * 24 * 60 * 60 * 1000;
/** An album keeps at most this many waiting friend invites; the oldest go first. */
export const MAX_OWED_PER_ALBUM = 20;

/** Waiting friend invites of one album: identity → when it started waiting (ms). */
export type OwedOffers = Record<string, number>;

/** `owed` with `identity` waiting since `now`; past the cap the oldest entries go. */
export function holdOwed(owed: OwedOffers | undefined, identity: string, now: number): OwedOffers {
  const next: OwedOffers = { ...owed, [identity]: now };
  const byAge = Object.entries(next).sort((a, b) => a[1] - b[1]);
  return Object.fromEntries(byAge.slice(Math.max(0, byAge.length - MAX_OWED_PER_ALBUM)));
}

/** The entries of `owed` that have not expired. A time too far ahead of `now` (a clock jump) is dropped. */
export function liveOwed(owed: OwedOffers | undefined, now: number): OwedOffers {
  const live: OwedOffers = {};
  for (const [identity, heldAt] of Object.entries(owed ?? {})) {
    if (now - heldAt < OFFER_HOLD_MS && heldAt <= now + OFFER_HOLD_MS) live[identity] = heldAt;
  }
  return live;
}

/** `owed` without `identity`; `undefined` when nothing is left. */
export function dropOwed(owed: OwedOffers | undefined, identity: string): OwedOffers | undefined {
  if (!owed) return undefined;
  const { [identity]: _gone, ...rest } = owed;
  return Object.keys(rest).length > 0 ? rest : undefined;
}
