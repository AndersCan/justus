import { definePlugin, ok } from "@ekrooh/bare/core";
import { sharedInSpecs } from "@justus/core";
import type { LazyMedia } from "./lazy-media";
import type { Files, Paths } from "./ports/files";
import { listSharedIn, removeSharedIn } from "./shared-in/inbox";

/** The `justus.sharedIn` plugin: photos other apps shared to Justus, waiting in the inbox. */
export function createSharedInPlugin(deps: {
  /** `<cacheDir>/shared-in`. */
  dir: string;
  files: Files;
  paths: Paths;
  media: LazyMedia;
}) {
  return definePlugin("justus.sharedIn", sharedInSpecs, {
    capabilities: ["sharedIn"],
    invoke: {
      list: async () => {
        const [e, listings] = listSharedIn(deps);
        if (e) return [e, null];
        for (const { batch, originals } of listings) {
          batch.photos.forEach((photo, i) => {
            deps.media.serve(photo.url, { mime: photo.type, open: async () => originals[i]! });
          });
        }
        const batches = listings.map((l) => l.batch);
        const photos = batches.reduce((n, b) => n + b.photos.length, 0);
        console.error(`[justus] shared-in.listed batches=${batches.length} photos=${photos}`);
        return ok({ batches });
      },
      remove: async (args) => {
        const [e, removed] = removeSharedIn(deps, args.ids);
        return e ? [e, null] : ok({ removed });
      },
    },
  });
}
