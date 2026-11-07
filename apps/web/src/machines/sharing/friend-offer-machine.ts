import { Actor, event, state } from "@mantaq/core";
import type { Clock } from "@mantaq/core";
import { withTimeout } from "@mantaq/sugar";

/**
 * A friend's invite in the albums list. The friend taps Join; there is no
 * Accept step on the Admin's side, so the album opens as soon as the Admin's
 * phone answers.
 */

/** Joins from an invite; resolves `[error, result]` like the gateway. */
export type FriendOfferPort = {
  joinOffer(code: string, owner: string): Promise<[unknown, unknown]>;
};

/** An invite from a friend, as the albums list shows it. */
export type FriendOffer = { code: string; owner: string; albumName: string; ownerName: string };

/** How long "Joining..." lasts before the row goes back to Join. */
export const JOIN_WAIT_MS = 30_000;

/** The backend's code for an invite the Admin no longer offers. */
export const OFFER_GONE_CODE = "justus.photos/offer-gone";

/** The invite rows show Join. */
const showingFriendOffers = state("showingFriendOffers")();
/** "Joining <album>..." The row's button is disabled until the Admin answers or 30 seconds pass. */
const joiningFriendsAlbum = state("joiningFriendsAlbum")<{ offer: FriendOffer }>();

/** The friend taps Join on an invite row. */
export const join = event("join")<{ offer: FriendOffer }>();
/** The Admin's phone answered for this invite. */
export const askAnswered = event("askAnswered")<{
  code: string;
  answer: "accepted" | "declined";
  folderId?: string;
}>();

/** The invite is gone: the Admin took it back before the friend joined. */
const offerGone = event("offerGone")();
/** The join could not go out, or no answer came within `JOIN_WAIT_MS`. */
const joinFailed = event("joinFailed")();

/** Asks the app to show the album. */
export const openAlbum = event("openAlbum")<{ folderId: string }>();
/** Asks the app to say "Couldn't join <album>. <owner> needs Justus open too." */
export const couldNotJoin = event("couldNotJoin")<{ albumName: string; ownerName: string }>();

/** The backend's error code, or "" when the error carries none. */
function codeOf(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    return typeof error.code === "string" ? error.code : "";
  }
  return "";
}

const allowAll: FriendOfferPort = { joinOffer: async () => [undefined, {}] };

export function createFriendOfferActor(options: { clock: Clock; port?: FriendOfferPort }) {
  const { clock, port = allowAll } = options;

  return Actor({
    inputs: [join, askAnswered],
    internal: [offerGone, joinFailed],
    outputs: [openAlbum, couldNotJoin],
    states: [showingFriendOffers, joiningFriendsAlbum],
    initial: showingFriendOffers,
    clock,
    setup: (m) => {
      /** "Join": the request goes out and the row shows "Joining...". */
      m.on(showingFriendOffers, {
        event: join,
        to: [joiningFriendsAlbum],
        handler: (e) => ({ state: joiningFriendsAlbum.create({ offer: e.payload.offer }) }),
      });

      /** The request goes to the Admin's phone. A refusal ends the wait at once. */
      m.effect(joiningFriendsAlbum, {
        name: "joinOffer",
        sends: [offerGone, joinFailed],
        fn: async ({ signal, emit, state: current }) => {
          const { code, owner } = current.payload.offer;
          let outcome: [unknown, unknown];
          try {
            outcome = await port.joinOffer(code, owner);
          } catch {
            if (!signal.aborted) emit(joinFailed.create());
            return;
          }
          if (signal.aborted) return;
          const [error] = outcome;
          if (!error) return;
          const gone = codeOf(error) === OFFER_GONE_CODE;
          emit(gone ? offerGone.create() : joinFailed.create());
        },
      });
      /** Waits 30 seconds for the Admin's answer. */
      m.effect(joiningFriendsAlbum, {
        name: "waitForAnswer",
        sends: [joinFailed],
        fn: (input) => withTimeout(JOIN_WAIT_MS, { input, event: () => joinFailed.create() }),
      });

      /** The Admin's phone accepted this invite: the album opens. An answer for another invite or a decline is ignored. */
      m.on(joiningFriendsAlbum, {
        event: askAnswered,
        to: [showingFriendOffers, joiningFriendsAlbum],
        handler: (e, { state: current }) => {
          const { offer } = current.payload;
          const { code, answer, folderId } = e.payload;
          if (code !== offer.code || answer !== "accepted" || folderId === undefined) {
            return { state: joiningFriendsAlbum.create(current.payload) };
          }
          return { state: showingFriendOffers, emit: [openAlbum.create({ folderId })] };
        },
      });
      /** The invite is gone: the row disappears with it, with no message. */
      m.on(joiningFriendsAlbum, {
        event: offerGone,
        to: [showingFriendOffers],
        handler: () => ({ state: showingFriendOffers }),
      });
      /** The join failed or timed out: the row returns to Join and the app says the Admin needs Justus open. */
      m.on(joiningFriendsAlbum, {
        event: joinFailed,
        to: [showingFriendOffers],
        handler: (_e, { state: current }) => ({
          state: showingFriendOffers,
          emit: [
            couldNotJoin.create({
              albumName: current.payload.offer.albumName,
              ownerName: current.payload.offer.ownerName,
            }),
          ],
        }),
      });
    },
  });
}
