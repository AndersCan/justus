import { invokeEvent, type EventSpec } from "@ekrooh/bare/core";
import type { Friend } from "./types";

/** Local, never replicated: the names this device gave to people, keyed by
 * their identity key. Both calls are fast file reads or writes. */
const FRIENDS_TIMEOUT_MS = 5_000;

export const friendSpecs = {
  list: {
    pluginId: "justus.friends",
    name: "friends.list",
    args: {} as Record<string, never>,
    result: {} as { friends: Friend[] },
  },
  add: {
    pluginId: "justus.friends",
    name: "friends.add",
    args: {} as { identity: string; name: string },
    result: {} as { friend: Friend },
  },
  remove: {
    pluginId: "justus.friends",
    name: "friends.remove",
    args: {} as { identity: string },
    result: {} as { removed: boolean },
  },
} as const satisfies Record<string, EventSpec<any, any>>;

export const friendEvents = {
  list() {
    return invokeEvent(friendSpecs.list, {}, null, FRIENDS_TIMEOUT_MS);
  },
  add(identity: string, name: string) {
    return invokeEvent(friendSpecs.add, { identity, name }, null, FRIENDS_TIMEOUT_MS);
  },
  remove(identity: string) {
    return invokeEvent(friendSpecs.remove, { identity }, null, FRIENDS_TIMEOUT_MS);
  },
};
