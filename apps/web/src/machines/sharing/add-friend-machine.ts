import { Actor, event, state } from "@mantaq/core";
import type { Clock } from "@mantaq/core";

/**
 * The Admin adds a saved friend to an album without a link. The Admin ticks one
 * or more friends and picks whether they join as Viewers or Collaborators; Justus
 * asks every ticked friend's phone at once. If it is not open, the Admin's phone
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

/** What happened when one ticked friend was asked. */
export type FriendAnswer = FriendChoice & { outcome: "asked" | "waiting" | NotReachedReason };

type Album = { folderId: string; albumName: string };

/** The People list shows "Add a friend". Nothing is open. */
const showingPeopleWithAddFriend = state("showingPeopleWithAddFriend")();
/** The identities the Admin has ticked, in the order ticked. Kept in the context so a tick redraws the sheet. */
type AddFriendContext = { ticked: string[] };

/** The sheet lists the saved friends who are not in the album yet, by name, each with a tick box. The role buttons wait until someone is ticked. */
const choosingFriends = state("choosingFriends")<Album & { choices: FriendChoice[] }>();
/** "Asking <friends>..." The sheet cannot be closed until every friend answers or the wait ends. */
const askingFriends = state("askingFriends")<
  Album & { friends: FriendChoice[]; role: FriendRole }
>();
/** At least one friend was not asked right away. The sheet says, one line per friend, who was asked and whose invite waits or failed, and offers Close. */
const showingWhoWasAsked = state("showingWhoWasAsked")<
  Album & { role: FriendRole; answers: FriendAnswer[] }
>();

/** The Admin taps "Add a friend". */
export const openPicker = event("openPicker")<{
  folderId: string;
  albumName: string;
  friends: SavedFriend[];
  memberIdentities: string[];
}>();
/** The Admin ticks or unticks a friend. */
export const toggleFriend = event("toggleFriend")<{ identity: string }>();
/** The Admin taps "Add <friends> as Viewers" or "as Collaborators". */
export const pickRole = event("pickRole")<{ role: FriendRole }>();
/** The Admin closes the sheet. */
export const closePicker = event("closePicker")();

/** Every ticked friend has been asked; carries what happened to each. */
const friendsAnswered = event("friendsAnswered")<{ answers: FriendAnswer[] }>();

/** Tells the app every ticked friend's phone took the invite: "Asked <friends> to join as <role>s". */
export const friendsAsked = event("friendsAsked")<{ names: string[]; role: FriendRole }>();

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

/** Asks one friend's phone and says what happened; never throws. */
async function askFriend(
  port: AddFriendPort,
  ask: { folderId: string; friend: FriendChoice; role: FriendRole },
): Promise<FriendAnswer> {
  const { folderId, friend, role } = ask;
  let outcome: [unknown, unknown];
  try {
    outcome = await port.offerAlbum(folderId, friend.identity, role);
  } catch {
    return { ...friend, outcome: "unreachable" };
  }
  const [error, result] = outcome;
  if (error) {
    return {
      ...friend,
      outcome: codeOf(error) === FRIEND_REFUSED_CODE ? "refused" : "unreachable",
    };
  }
  return { ...friend, outcome: isWaiting(result) ? "waiting" : "asked" };
}

export function createAddFriendActor(options: { clock: Clock; port?: AddFriendPort }) {
  const { clock, port = allowAll } = options;

  return Actor({
    inputs: [openPicker, toggleFriend, pickRole, closePicker],
    internal: [friendsAnswered],
    outputs: [friendsAsked],
    states: [showingPeopleWithAddFriend, choosingFriends, askingFriends, showingWhoWasAsked],
    initial: showingPeopleWithAddFriend,
    context: { ticked: [] } as AddFriendContext,
    clock,
    setup: (m) => {
      for (const from of [showingPeopleWithAddFriend, showingWhoWasAsked]) {
        /** "Add a friend": the saved friends who are not members are listed by name, none ticked; with none, nothing opens. */
        m.on(from, {
          event: openPicker,
          to: [choosingFriends, showingPeopleWithAddFriend],
          handler: (e, { context }) => {
            const { folderId, albumName, friends, memberIdentities } = e.payload;
            const choices = friendChoices(friends, memberIdentities);
            context.set({ ticked: [] });
            return choices.length === 0
              ? { state: showingPeopleWithAddFriend }
              : { state: choosingFriends.create({ folderId, albumName, choices }) };
          },
        });
      }

      /** A friend is ticked or unticked. A name that is not on the list is ignored. */
      m.on(choosingFriends, {
        event: toggleFriend,
        to: [choosingFriends],
        handler: (e, { state: current, context }) => {
          const { ticked } = context.get();
          const { identity } = e.payload;
          if (current.payload.choices.some((c) => c.identity === identity)) {
            context.set({
              ticked: ticked.includes(identity)
                ? ticked.filter((id) => id !== identity)
                : [...ticked, identity],
            });
          }
          return { state: choosingFriends.create(current.payload) };
        },
      });

      /** A role is picked and every ticked friend's phone is asked. With nobody ticked nothing happens. */
      m.on(choosingFriends, {
        event: pickRole,
        to: [askingFriends, choosingFriends],
        handler: (e, { state: current, context }) => {
          const { choices, folderId, albumName } = current.payload;
          const { ticked } = context.get();
          const friends = choices.filter((c) => ticked.includes(c.identity));
          return friends.length === 0
            ? { state: choosingFriends.create(current.payload) }
            : {
                state: askingFriends.create({ folderId, albumName, friends, role: e.payload.role }),
              };
        },
      });

      for (const from of [choosingFriends, showingWhoWasAsked]) {
        /** Close: back to the People list. */
        m.on(from, {
          event: closePicker,
          to: [showingPeopleWithAddFriend],
          handler: () => ({ state: showingPeopleWithAddFriend }),
        });
      }

      /** Every ticked friend's phone is asked at once, each with up to 30 seconds for an answer. */
      m.effect(askingFriends, {
        name: "offerAlbum",
        sends: [friendsAnswered],
        fn: async ({ emit, state: current }) => {
          const { folderId, friends, role } = current.payload;
          const answers = await Promise.all(
            friends.map((friend) => askFriend(port, { folderId, friend, role })),
          );
          emit(friendsAnswered.create({ answers }));
        },
      });
      /** Every phone took the invite: the sheet closes and the Admin is told. Otherwise the sheet says who was asked and who was not. */
      m.on(askingFriends, {
        event: friendsAnswered,
        to: [showingPeopleWithAddFriend, showingWhoWasAsked],
        handler: (e, { state: current }) => {
          const { answers } = e.payload;
          const { role, folderId, albumName } = current.payload;
          if (answers.every((a) => a.outcome === "asked")) {
            return {
              state: showingPeopleWithAddFriend,
              emit: [friendsAsked.create({ names: answers.map((a) => a.name), role })],
            };
          }
          return { state: showingWhoWasAsked.create({ folderId, albumName, role, answers }) };
        },
      });
    },
  });
}
