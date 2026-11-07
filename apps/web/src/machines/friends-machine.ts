import { Actor, RealClock, event, state, type Clock, type Snapshot } from "@mantaq/core";
import type { Friend } from "@justus/core";
import { gateway } from "../gateway";
import { runInvoke } from "./actor-utils";

/**
 * Add a person to the friends list: the sheet opened from a member row shows
 * who they are, lets the person give them a name, and saves it on this device.
 * The friends list is loaded once when the app starts.
 */

export type FriendTarget = { identity: string; ownName: string };
export type FriendsPort = Pick<typeof gateway.friends, "list" | "add">;

export const FRIEND_NAME_LIMIT = 40;
export const SAVE_FAILED_COPY = "Couldn't save. Try again.";

/** The saved friends are being read from this device; the sheet cannot open yet. */
const loadingFriends = state("loadingFriends")();
/** No friend sheet is showing. */
const friendSheetClosed = state("friendSheetClosed")();
/** The sheet shows one person from the album and whether they are already a friend. */
const showingMember = state("showingMember")<FriendTarget>();
/** The person is typing the name to give this friend. */
const namingFriend = state("namingFriend")<FriendTarget & { draft: string }>();
/** The name is being saved on this device; the buttons wait. */
const savingFriend = state("savingFriend")<FriendTarget & { name: string }>();

/** The person taps a member to see them in the friend sheet. */
const open = event("OPEN")<{ target: FriendTarget }>();
/** The person taps Add to friends. */
const add = event("ADD")();
/** The person types in the name field. */
const type = event("TYPE")<{ text: string }>();
/** The person taps Save. */
const save = event("SAVE")();
/** The person closes the friend sheet. */
const close = event("CLOSE")();
/** The saved friends were read from this device. */
const loaded = event("LOADED")<{ friends: Friend[] }>();
/** The saved friends could not be read. */
const loadFailed = event("LOAD_FAILED")<{ message: string }>();
/** The friend was saved. */
const saved = event("SAVED")<{ friend: Friend }>();
/** The friend could not be saved. */
const saveFailed = event("SAVE_FAILED")<{ message: string }>();
/** A new friend was saved under this name, so the app can say so. */
const friendSaved = event("FRIEND_SAVED")<{ name: string }>();

type FriendsContext = { friends: Record<string, string>; error: string | null };

const initialContext: FriendsContext = { friends: {}, error: null };

/** The clock and the friends port are injected so tests and the flow inspector can drive the machine. */
export function createFriendsActor(options: { clock: Clock; port?: FriendsPort }) {
  const { clock, port = gateway.friends } = options;
  return Actor({
    inputs: [open, add, type, save, close],
    internal: [loaded, loadFailed, saved, saveFailed],
    outputs: [friendSaved],
    states: [loadingFriends, friendSheetClosed, showingMember, namingFriend, savingFriend],
    initial: loadingFriends,
    clock,
    context: initialContext,
    setup: (m) => {
      /** The saved friends are read from this device; if that fails, the app carries on with no friends. */
      m.effect(loadingFriends, {
        name: "loadingFriends",
        sends: [loaded, loadFailed],
        fn: ({ signal, emit }) =>
          runInvoke(
            signal,
            () => port.list(),
            (result) =>
              emit(
                loaded.create({ friends: (result as { friends: Friend[] } | null)?.friends ?? [] }),
              ),
            (message) => emit(loadFailed.create({ message })),
          ),
      });
      /** The friends are known, so the sheet can open. */
      m.on(loadingFriends, {
        event: loaded,
        to: [friendSheetClosed],
        handler: (e, opts) => {
          const friends: Record<string, string> = {};
          for (const f of e.payload.friends) friends[f.identity] = f.name;
          opts.context.set({ friends, error: null });
          return { state: friendSheetClosed };
        },
      });
      /** Reading the friends failed; nobody is shown as a friend and no error is shown. */
      m.on(loadingFriends, {
        event: loadFailed,
        to: [friendSheetClosed],
        handler: (e) => {
          console.error("friends: could not load", e.payload.message);
          return { state: friendSheetClosed };
        },
      });

      /** The person taps a member and the friend sheet opens for them. */
      m.on(friendSheetClosed, {
        event: open,
        to: [showingMember],
        handler: (e, opts) => {
          opts.context.set({ ...opts.context.get(), error: null });
          return { state: showingMember.create(e.payload.target) };
        },
      });
      /** The person starts naming a member who is not a friend yet, with their own name as the first draft. */
      m.on(showingMember, {
        event: add,
        to: [namingFriend, showingMember],
        handler: (_e, opts) => {
          const target = opts.state.payload;
          if (opts.context.get().friends[target.identity] !== undefined) {
            return { state: showingMember.create(target) };
          }
          return { state: namingFriend.create({ ...target, draft: target.ownName }) };
        },
      });
      /** Closing the sheet from the member view hides it. */
      m.on(showingMember, {
        event: close,
        to: [friendSheetClosed],
        handler: (_e, opts) => {
          opts.context.set({ ...opts.context.get(), error: null });
          return { state: friendSheetClosed };
        },
      });
      /** Closing the sheet while naming throws the draft away. */
      m.on(namingFriend, {
        event: close,
        to: [friendSheetClosed],
        handler: (_e, opts) => {
          opts.context.set({ ...opts.context.get(), error: null });
          return { state: friendSheetClosed };
        },
      });
      /** Typing changes the draft, cut to the longest name allowed, and clears any save error. */
      m.on(namingFriend, {
        event: type,
        to: [namingFriend],
        handler: (e, opts) => {
          opts.context.set({ ...opts.context.get(), error: null });
          return {
            state: namingFriend.create({
              ...opts.state.payload,
              draft: e.payload.text.slice(0, FRIEND_NAME_LIMIT),
            }),
          };
        },
      });
      /** Save starts only when the draft has something other than spaces in it. */
      m.on(namingFriend, {
        event: save,
        to: [savingFriend, namingFriend],
        handler: (_e, opts) => {
          const { identity, ownName, draft } = opts.state.payload;
          const name = draft.trim();
          if (name === "") return { state: namingFriend.create(opts.state.payload) };
          return { state: savingFriend.create({ identity, ownName, name }) };
        },
      });

      /** The name is saved on this device; if that fails, the person sees why and can try again. */
      m.effect(savingFriend, {
        name: "savingFriend",
        sends: [saved, saveFailed],
        fn: ({ signal, emit, state: current }) => {
          const { identity, name } = current.payload;
          return runInvoke(
            signal,
            () => port.add(identity, name),
            (result) =>
              emit(
                saved.create({
                  friend: (result as { friend: Friend } | null)?.friend ?? { identity, name },
                }),
              ),
            (message) => emit(saveFailed.create({ message })),
          );
        },
      });
      /** The friend is kept, the sheet closes and the app is told the name. */
      m.on(savingFriend, {
        event: saved,
        to: [friendSheetClosed],
        handler: (e, opts) => {
          const ctx = opts.context.get();
          opts.context.set({
            friends: { ...ctx.friends, [e.payload.friend.identity]: e.payload.friend.name },
            error: null,
          });
          return {
            state: friendSheetClosed,
            emit: [friendSaved.create({ name: e.payload.friend.name })],
          };
        },
      });
      /** Saving failed: the person is back at the name with their draft and a short message. */
      m.on(savingFriend, {
        event: saveFailed,
        to: [namingFriend],
        handler: (_e, opts) => {
          const { identity, ownName, name } = opts.state.payload;
          opts.context.set({ ...opts.context.get(), error: SAVE_FAILED_COPY });
          return { state: namingFriend.create({ identity, ownName, draft: name }) };
        },
      });
    },
  });
}

export type FriendSheet = {
  state: "loadingFriends" | "friendSheetClosed" | "showingMember" | "namingFriend" | "savingFriend";
  target: FriendTarget | null;
  draft: string;
  error: string | null;
  canSave: boolean;
};

/** What the friend sheet draws, as a pure function of the actor snapshot. */
export function friendSheetOf(snapshot: Snapshot<FriendsContext>): FriendSheet {
  const name = snapshot.path[0] as FriendSheet["state"];
  const payload = snapshot.payload as
    | (Partial<FriendTarget> & { draft?: string; name?: string })
    | undefined;
  const target =
    payload?.identity !== undefined && payload.ownName !== undefined
      ? { identity: payload.identity, ownName: payload.ownName }
      : null;
  const draft = payload?.draft ?? payload?.name ?? "";
  return {
    state: name,
    target,
    draft,
    error: snapshot.context.error,
    canSave: name === "namingFriend" && draft.trim() !== "",
  };
}

export const friendsActor = createFriendsActor({ clock: RealClock() });

export const friends = {
  open: (target: FriendTarget) => friendsActor.send(open.create({ target })),
  add: () => friendsActor.send(add.create()),
  type: (text: string) => friendsActor.send(type.create({ text })),
  save: () => friendsActor.send(save.create()),
  close: () => friendsActor.send(close.create()),
};
