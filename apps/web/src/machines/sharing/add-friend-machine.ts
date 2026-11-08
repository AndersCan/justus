import { Actor, event, state } from "@mantaq/core";
import type { Clock } from "@mantaq/core";

/**
 * The Admin adds a saved friend to an album without a link. The Admin picks a
 * friend and whether they join as a Viewer or a Collaborator; Justus asks that
 * friend's phone. If it is not open, the Admin's phone
 * keeps the invite and sends it the next time both have Justus open. There is
 * no Accept step on the Admin's side.
 */

/** Asks a friend's phone to offer them the album; resolves `[error, result]` like the gateway. */
export type AddFriendPort = {
  offerAlbum(folderId: string, identity: string, role: FriendRole): Promise<[unknown, unknown]>;
};

/** What the friend becomes when they join: a Viewer (`reader`) or a Collaborator (`member`). */
export type FriendRole = "reader" | "member";

/** A saved friend the Admin can pick. */
export type FriendChoice = { identity: string; name: string };

/** A saved friend, as the friends list holds it. */
type SavedFriend = { identity: string; name: string };

/** Saved friends who are not members of the album, sorted by name (case- and accent-insensitive). */
export function friendChoices(friends: SavedFriend[], memberIdentities: string[]): FriendChoice[] {
  return friends
    .filter((f) => !memberIdentities.includes(f.identity))
    .map((f) => ({ identity: f.identity, name: f.name }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

/** The reason the friend could not be asked. */
export type NotReachedReason = "unreachable" | "refused";

/** The backend's code for a friend's phone that turned the invite down. */
export const FRIEND_REFUSED_CODE = "justus.photos/friend-refused";

type Album = { folderId: string; albumName: string };
type Picked = Album & { identity: string; name: string };
type Asked = Picked & { role: FriendRole };

/** The People list shows "Add a friend". Nothing is open. */
const showingPeopleWithAddFriend = state("showingPeopleWithAddFriend")();
/** The sheet lists the saved friends who are not in the album yet, by name. */
const choosingFriend = state("choosingFriend")<Album & { choices: FriendChoice[] }>();
/** The Admin picked a friend; the sheet asks whether they join as a Viewer or a Collaborator. */
const choosingFriendRole = state("choosingFriendRole")<Picked>();
/** "Asking <friend>..." The sheet cannot be closed until the friend answers or the wait ends. */
const lookingForFriend = state("lookingForFriend")<Asked>();
/** The friend's phone did not take the invite. The sheet says why in one line and offers Close. */
const couldNotReachFriend = state("couldNotReachFriend")<Asked & { reason: NotReachedReason }>();

/** The friend did not answer in time. The Admin's phone keeps the invite and sends it the next time both have Justus open. */
const inviteWaitingForFriend = state("inviteWaitingForFriend")<Asked>();

/** The Admin taps "Add a friend". */
export const openPicker = event("openPicker")<{
  folderId: string;
  albumName: string;
  friends: SavedFriend[];
  memberIdentities: string[];
}>();
/** The Admin taps a friend's name. */
export const pickFriend = event("pickFriend")<{ identity: string }>();
/** The Admin taps "Add <friend> as a Viewer" or "as a Collaborator". */
export const pickRole = event("pickRole")<{ role: FriendRole }>();
/** The Admin closes the sheet. */
export const closePicker = event("closePicker")();

/** The friend's phone took the invite. */
const friendReached = event("friendReached")();
/** The friend did not answer; the invite is kept. */
const friendAway = event("friendAway")();
/** The friend's phone did not take the invite. */
const friendNotReached = event("friendNotReached")<{ reason: NotReachedReason }>();

/** Tells the app the friend was asked: "Asked <friend> to join as a <role>". */
export const friendAsked = event("friendAsked")<{ name: string; role: FriendRole }>();

/** The backend's error code, or "" when the error carries none. */
function codeOf(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    return typeof error.code === "string" ? error.code : "";
  }
  return "";
}

/** True when the backend kept the invite because the friend did not answer. */
function isWaiting(result: unknown): boolean {
  return (
    typeof result === "object" && result !== null && "waiting" in result && result.waiting === true
  );
}

const allowAll: AddFriendPort = { offerAlbum: async () => [undefined, {}] };

export function createAddFriendActor(options: { clock: Clock; port?: AddFriendPort }) {
  const { clock, port = allowAll } = options;

  return Actor({
    inputs: [openPicker, pickFriend, pickRole, closePicker],
    internal: [friendReached, friendAway, friendNotReached],
    outputs: [friendAsked],
    states: [
      showingPeopleWithAddFriend,
      choosingFriend,
      choosingFriendRole,
      lookingForFriend,
      inviteWaitingForFriend,
      couldNotReachFriend,
    ],
    initial: showingPeopleWithAddFriend,
    clock,
    setup: (m) => {
      for (const from of [
        showingPeopleWithAddFriend,
        inviteWaitingForFriend,
        couldNotReachFriend,
      ]) {
        /** "Add a friend": the saved friends who are not members are listed by name; with none, nothing opens. */
        m.on(from, {
          event: openPicker,
          to: [choosingFriend, showingPeopleWithAddFriend],
          handler: (e) => {
            const { folderId, albumName, friends, memberIdentities } = e.payload;
            const choices = friendChoices(friends, memberIdentities);
            return choices.length === 0
              ? { state: showingPeopleWithAddFriend }
              : { state: choosingFriend.create({ folderId, albumName, choices }) };
          },
        });
      }

      /** A friend is picked and the sheet asks for their role. A name that is not on the list is ignored. */
      m.on(choosingFriend, {
        event: pickFriend,
        to: [choosingFriendRole, choosingFriend],
        handler: (e, { state: current }) => {
          const { choices, ...album } = current.payload;
          const picked = choices.find((c) => c.identity === e.payload.identity);
          return picked === undefined
            ? { state: choosingFriend.create(current.payload) }
            : { state: choosingFriendRole.create({ ...album, ...picked }) };
        },
      });

      /** A role is picked and the friend's phone is asked. */
      m.on(choosingFriendRole, {
        event: pickRole,
        to: [lookingForFriend],
        handler: (e, { state: current }) => ({
          state: lookingForFriend.create({ ...current.payload, role: e.payload.role }),
        }),
      });

      for (const from of [
        choosingFriend,
        choosingFriendRole,
        inviteWaitingForFriend,
        couldNotReachFriend,
      ]) {
        /** Close: back to the People list. */
        m.on(from, {
          event: closePicker,
          to: [showingPeopleWithAddFriend],
          handler: () => ({ state: showingPeopleWithAddFriend }),
        });
      }

      /** The friend's phone is asked, with up to 30 seconds for an answer. */
      m.effect(lookingForFriend, {
        name: "offerAlbum",
        sends: [friendReached, friendAway, friendNotReached],
        fn: async ({ signal, emit, state: current }) => {
          const { folderId, identity, role } = current.payload;
          let outcome: [unknown, unknown];
          try {
            outcome = await port.offerAlbum(folderId, identity, role);
          } catch {
            if (!signal.aborted) emit(friendNotReached.create({ reason: "unreachable" }));
            return;
          }
          if (signal.aborted) return;
          const [error, result] = outcome;
          if (!error && isWaiting(result)) emit(friendAway.create());
          else if (!error) emit(friendReached.create());
          else {
            emit(
              friendNotReached.create({
                reason: codeOf(error) === FRIEND_REFUSED_CODE ? "refused" : "unreachable",
              }),
            );
          }
        },
      });
      /** The friend's phone took the invite: the sheet closes and the Admin is told. There is nothing more to do. */
      m.on(lookingForFriend, {
        event: friendReached,
        to: [showingPeopleWithAddFriend],
        handler: (_e, { state: current }) => ({
          state: showingPeopleWithAddFriend,
          emit: [friendAsked.create({ name: current.payload.name, role: current.payload.role })],
        }),
      });
      /** The friend did not answer: the invite waits and the sheet says so. */
      m.on(lookingForFriend, {
        event: friendAway,
        to: [inviteWaitingForFriend],
        handler: (_e, { state: current }) => ({
          state: inviteWaitingForFriend.create(current.payload),
        }),
      });
      /** The friend's phone refused, or the invoke failed: the sheet says so and offers Close. */
      m.on(lookingForFriend, {
        event: friendNotReached,
        to: [couldNotReachFriend],
        handler: (e, { state: current }) => ({
          state: couldNotReachFriend.create({ ...current.payload, reason: e.payload.reason }),
        }),
      });
    },
  });
}
