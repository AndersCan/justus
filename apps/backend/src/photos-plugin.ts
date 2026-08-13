import { CoreError, definePlugin } from "@ekrooh/bare/core";
import { photoSpecs } from "@justus/core";
import type { PhotoStore } from "./photo-store";

function errResult(error: unknown): [CoreError, null] {
  const message = error instanceof Error ? error.message : String(error);
  return [new CoreError("PLUGIN_ERROR", message), null];
}

/** The `justus.photos` plugin — the worklet surface the web layer calls. */
export function createPhotosPlugin(deps: { store: PhotoStore }) {
  return definePlugin("justus.photos", photoSpecs, {
    capabilities: ["photos"],
    invoke: {
      list: async () => {
        try {
          const photos = await deps.store.list();
          return [null, { photos }];
        } catch (e) {
          return errResult(e);
        }
      },
      add: async (args) => deps.store.add(args.path),
      remove: async (args) => deps.store.remove(args.id),
      join: async (args) => deps.store.join(args.key),
      enroll: async (args) => deps.store.enroll(args.key, args.name),
      status: async () => {
        try {
          return [null, await deps.store.status()];
        } catch (e) {
          return errResult(e);
        }
      },
    },
  });
}
