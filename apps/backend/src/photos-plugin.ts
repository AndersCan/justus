import { CoreError, definePlugin, type PluginContext } from "@ekrooh/bare/core";
import { checkPhotoResult, photoSpecs } from "@justus/core";
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

/** Wraps an invoke handler so its result is checked against the shared
 * backend/web contract (`@justus/core` contract.ts). A violation becomes a
 * PLUGIN_ERROR naming the field, so drift fails loudly where it starts.
 * Off in production (`checkContract` unset): walking every photo of a large
 * `list` on every call is not free on a phone, and the web layer validates
 * on receipt anyway. Dev mode and tests turn it on. */
function checked<A extends unknown[]>(
  name: string,
  on: boolean | undefined,
  fn: (...a: A) => unknown,
) {
  if (!on) return fn;
  return async (...a: A) => {
    const out = (await fn(...a)) as [unknown, unknown];
    if (out[0]) return out;
    const message = checkPhotoResult(name, out[1]);
    return message ? errResult(new Error(message)) : out;
  };
}

/** The `justus.photos` plugin — the worklet surface the web layer calls. */
export function createPhotosPlugin(deps: { store: PhotoStore; checkContract?: boolean }) {
  const wrap = <T extends Record<string, (...a: never[]) => unknown>>(handlers: T): T =>
    Object.fromEntries(
      Object.entries(handlers).map(([key, fn]) => [
        key,
        checked(`photos.${key}`, deps.checkContract, fn as never),
      ]),
    ) as T;
  return definePlugin("justus.photos", photoSpecs, {
    capabilities: ["photos"],
    invoke: wrap({
      list: async (args) => {
        try {
          const photos = await deps.store.list({ all: args?.all === true });
          return [null, { photos }];
        } catch (e) {
          return errResult(e);
        }
      },
      add: async (args, context: PluginContext) => {
        // Two add flows share one invoke: a host-picked file already on disk
        // (`path`), or bytes uploaded in-band as the invoke payload from the
        // browser multi-file picker (`name` + payload).
        // A host that encoded the shared copies passes them alongside.
        if (args.path) {
          const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
          return deps.store.add(args.path, args.name, args.folderId, {
            thumb: str(args.thumb),
            original: str(args.original),
            takenAt: str(args.takenAt),
          });
        }
        const payload = context?.payload;
        if (payload && payload.byteLength > 0) {
          if (payload.byteLength > MAX_INBAND_ADD_BYTES) {
            return errResult(new Error("photos.add payload exceeds size limit"));
          }
          const name =
            typeof args.name === "string" && args.name.trim()
              ? args.name
              : `photo-${Date.now()}.jpg`;
          return deps.store.addBytes(name, payload, args.folderId);
        }
        return errResult(new Error("photos.add needs a path or file bytes"));
      },
      remove: async (args) => deps.store.remove(args.id, args.folderId),
      join: async (args) => deps.store.join(args.key, args.name),
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
      ask: async (args) =>
        deps.store.ask({
          code: args.code,
          owner: args.owner,
          albumName: args.albumName,
          ownerName: args.ownerName,
        }),
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
      makeMember: async (args) => deps.store.makeMember(args.folderId, args.memberKey),
      makeViewer: async (args) => deps.store.makeViewer(args.folderId, args.memberKey),
      removeMember: async (args) => deps.store.removeMember(args.folderId, args.memberKey),
      respond: async (args) =>
        deps.store.respond(args.folderId, args.requesterKey, args.approve, args.role),
      turnOffInvite: async (args) => deps.store.turnOffInvite(args.folderId),
      offerAlbum: async (args) => deps.store.offerAlbum(args.folderId, args.identity),
      joinOffer: async (args) => deps.store.joinOffer(args.code, args.owner),
      archiveAlbum: async (args) => deps.store.archiveAlbum(args.folderId),
      restoreAlbum: async (args) => deps.store.restoreAlbum(args.folderId),
      deleteAlbum: async (args) => deps.store.deleteAlbum(args.folderId),
      leaveAlbum: async (args) => deps.store.leaveAlbum(args.folderId),
      dismissAlbumNotice: async (args) => deps.store.dismissAlbumNotice(args.folderId),
      dismissDeclinedAsk: async (args) => deps.store.dismissDeclinedAsk(args.code),
      cancelAsk: async (args) => deps.store.cancelAsk(args.code),
    }),
  });
}
