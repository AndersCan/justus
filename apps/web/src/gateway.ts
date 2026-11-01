import {
  createPluginBus,
  createProtocolMessenger,
  MessageType,
  type InvokeEnvelope,
} from "@ekrooh/bare/core";
import {
  photoEvents,
  logEvents,
  grantEvents,
  justusMediaEvents,
  type AddExtras,
  type LogLevel,
} from "@justus/core";
import { guardResult } from "./contract-guard";
import { getTransport } from "./transport";
import { workletBase } from "./utils/peer";
import { encodePhoto } from "./utils/encode-photo";

export const transport = getTransport();

export const messenger = createProtocolMessenger((request, payload) => {
  transport.send(MessageType.ENVELOPE, request, payload);
});

export const bus = createPluginBus(messenger);

/** `bus.invoke` with every `justus.photos` result checked against the shared
 * backend/web contract (see `contract-guard.ts`). */
async function invoke<R>(envelope: InvokeEnvelope<string, Record<string, unknown>, R>) {
  return guardResult(envelope, await bus.invoke(envelope));
}

/** The plugin-invoke shell the mantaq actors drive. Every call returns the
 * framework's `Either` tuple `[error, result]`. */
export const gateway = {
  /** Every album's photos, newest first. */
  list: () => invoke(photoEvents.photos.list(true)),
  add: (path: string, name?: string, folderId?: string, extras?: AddExtras) =>
    invoke(photoEvents.photos.add(path, name, folderId, extras)),
  /** Adds a photo from bytes picked in the browser (multi-file upload). */
  addFile: (name: string, bytes: Uint8Array | ArrayBuffer) =>
    invoke(photoEvents.photos.addFile(name, bytes)),
  /** Encodes a browser-picked file into the copies an album shares and posts
   * them to the worklet's `POST /photos` route (same-origin in the WebView,
   * Vite-proxied in dev): the thumbnail, then the display copy, in one body.
   * The original stays in the page. Same `Either` shape as an invoke; the
   * route answers with the stored (or deduped) photo's id. */
  upload: async (
    file: File,
    folderId?: string,
  ): Promise<[Error | null, { id?: string } | null]> => {
    try {
      const photo = await encodePhoto(file);
      const query = new URLSearchParams({
        filename: photo.filename,
        name: file.name,
        thumb: String(photo.thumb.size),
        ...(folderId ? { folder: folderId } : {}),
        ...(photo.sha256 ? { sha256: photo.sha256 } : {}),
        ...(photo.takenAt ? { takenAt: photo.takenAt } : {}),
      });
      const response = await fetch(`${workletBase()}/photos?${query}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Blob([photo.thumb, photo.display]),
      });
      const body = (await response.json().catch(() => null)) as {
        id?: string;
        error?: string;
      } | null;
      if (!response.ok) return [new Error(body?.error ?? `HTTP ${response.status}`), null];
      return [null, { id: body?.id }];
    } catch (e) {
      return [e instanceof Error ? e : new Error(String(e)), null];
    }
  },
  remove: (id: string, folderId?: string) => invoke(photoEvents.photos.remove(id, folderId)),
  join: (key: string, name?: string) => invoke(photoEvents.photos.join(key, name)),
  enroll: (key: string, name: string) => invoke(photoEvents.photos.enroll(key, name)),
  status: () => invoke(photoEvents.photos.status()),
  folders: () => invoke(photoEvents.photos.folders()),
  createFolder: (name: string) => invoke(photoEvents.photos.createFolder(name)),
  setActive: (folderId: string) => invoke(photoEvents.photos.setActive(folderId)),
  setName: (name: string) => invoke(photoEvents.photos.setName(name)),
  requests: () => invoke(photoEvents.photos.requests()),
  respond: (folderId: string, requesterKey: string, approve: boolean) =>
    invoke(photoEvents.photos.respond(folderId, requesterKey, approve)),
  removeMember: (folderId: string, memberKey: string) =>
    invoke(photoEvents.photos.removeMember(folderId, memberKey)),
  /** Native-host pick/capture (`justus.media`): staged file paths. */
  media: {
    pickMany: () => invoke(justusMediaEvents.media.pickMany()),
    capture: () => invoke(justusMediaEvents.media.capture()),
  },
  logs: {
    view: (opts?: { tail?: number; level?: LogLevel; sources?: string[] }) =>
      invoke(logEvents.view(opts)),
    clear: () => invoke(logEvents.clear()),
  },
  grants: {
    view: () => invoke(grantEvents.view()),
    grant: (peerId: string) => invoke(grantEvents.grant(peerId)),
    decline: (peerId: string) => invoke(grantEvents.decline(peerId)),
    revoke: (peerId: string) => invoke(grantEvents.revoke(peerId)),
    snooze: () => invoke(grantEvents.snooze()),
  },
};
