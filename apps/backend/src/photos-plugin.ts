import { CoreError, definePlugin, type PluginContext } from "@ekrooh/bare/core";
import { photoSpecs } from "@justus/core";
import type { PhotoStore } from "./photo-store";

// Mirror the upload route's cap (upload-route.ts MAX_UPLOAD_BYTES): the in-band
// add path writes the payload to a temp file and then reads it fully into
// memory, so an unbounded picker payload is a memory/disk DoS. The native
// picker path (`args.path`) is already a file on the device and is not capped.
const MAX_INBAND_ADD_BYTES = 50 * 1024 * 1024;

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
      add: async (args, context: PluginContext) => {
        // Two add flows share one invoke: a host-picked file already on disk
        // (`path`), or bytes uploaded in-band as the invoke payload from the
        // browser multi-file picker (`name` + payload).
        if (args.path) return deps.store.add(args.path, args.name);
        const payload = context?.payload;
        if (payload && payload.byteLength > 0) {
          if (payload.byteLength > MAX_INBAND_ADD_BYTES) {
            return errResult(new Error("photos.add payload exceeds size limit"));
          }
          const name =
            typeof args.name === "string" && args.name.trim()
              ? args.name
              : `photo-${Date.now()}.jpg`;
          return deps.store.addBytes(name, payload);
        }
        return errResult(new Error("photos.add needs a path or file bytes"));
      },
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
      folders: async () => {
        try {
          return [null, await deps.store.folders()];
        } catch (e) {
          return errResult(e);
        }
      },
      createFolder: async (args) => deps.store.createFolder(args.name),
      setActive: async (args) => deps.store.setActive(args.folderId),
      setName: async (args) => deps.store.setName(args.name),
      requests: async () => {
        try {
          return [null, await deps.store.requests()];
        } catch (e) {
          return errResult(e);
        }
      },
      respond: async (args) => deps.store.respond(args.folderId, args.requesterKey, args.approve),
    },
  });
}
