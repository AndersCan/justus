import { definePlugin } from "@ekrooh/bare/core";
import { friendSpecs } from "@justus/core";
import type { FriendsStore } from "./friends-store";

/** The `justus.friends` plugin: the names this device gave to people. */
export function createFriendsPlugin(deps: { store: FriendsStore }) {
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
      remove: async (args) => {
        const [e, result] = await deps.store.remove(args.identity);
        return e ? [e, null] : [null, result];
      },
    },
  });
}
