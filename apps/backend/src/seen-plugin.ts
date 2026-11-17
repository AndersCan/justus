import { definePlugin } from "@ekrooh/bare/core";
import { seenSpecs } from "@justus/core";
import type { SeenStore } from "./seen-store";

/** The `justus.seen` plugin: what this phone has looked at. */
export function createSeenPlugin(deps: { store: SeenStore }) {
  return definePlugin("justus.seen", seenSpecs, {
    capabilities: ["seen"],
    invoke: {
      read: async () => {
        const [e, seen] = deps.store.read();
        return e ? [e, null] : [null, { seen }];
      },
      write: async (args) => {
        const [e] = await deps.store.write(args.seen);
        return e ? [e, null] : [null, {}];
      },
    },
  });
}
