import { definePlugin, err } from "@ekrooh/bare/core";
import { FriendError, friendSpecs } from "@justus/core";
import type { FriendsStore } from "./friends-store";
import { isHexKey } from "./membership/records";
import { pairWords } from "./membership/pair-words";

/** The `justus.friends` plugin: the names this device gave to people. */
export function createFriendsPlugin(deps: {
  store: FriendsStore;
  ownIdentity: () => string | undefined;
  crypto: Pick<typeof import("bare-crypto"), "createHash">;
}) {
  return definePlugin("justus.friends", friendSpecs, {
    capabilities: ["friends"],
    invoke: {
      list: async () => {
        const [e, friends] = deps.store.list();
        return e ? [e, null] : [null, { friends }];
      },
      add: async (args) => {
        const [e, friend] = await deps.store.add(args.identity, args.name);
        return e ? [e, null] : [null, { friend }];
      },
      rename: async (args) => {
        const [e, friend] = await deps.store.rename(args.identity, args.name);
        return e ? [e, null] : [null, { friend }];
      },
      remove: async (args) => {
        const [e, result] = await deps.store.remove(args.identity);
        return e ? [e, null] : [null, result];
      },
      words: async (args) => {
        if (!isHexKey(args.identity)) {
          return err(FriendError.INVALID_KEY, "identity must be 64 hex characters");
        }
        const own = deps.ownIdentity();
        if (own === undefined || own.toLowerCase() === args.identity.toLowerCase()) {
          return [null, {}];
        }
        return [null, { words: pairWords(own, args.identity, deps.crypto) }];
      },
    },
  });
}
