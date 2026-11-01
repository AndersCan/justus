import { createPluginBus, createProtocolMessenger, MessageType } from "@ekrooh/bare/core";
import {
  photoEvents,
  logEvents,
  grantEvents,
  justusMediaEvents,
  type AddExtras,
  type LogLevel,
} from "@justus/core";
import { getTransport } from "./transport";
import { workletBase } from "./utils/peer";
import { encodePhoto } from "./utils/encode-photo";

export const transport = getTransport();

export const messenger = createProtocolMessenger((request, payload) => {
  transport.send(MessageType.ENVELOPE, request, payload);
});

export const bus = createPluginBus(messenger);

/** The plugin-invoke shell the mantaq actors drive. Every call returns the
 * framework's `Either` tuple `[error, result]`. */
export const gateway = {
  /** Every album's photos, newest first. */
  list: () => bus.invoke(photoEvents.photos.list(true)),
  add: (path: string, name?: string, folderId?: string, extras?: AddExtras) =>
    bus.invoke(photoEvents.photos.add(path, name, folderId, extras)),
  /** Adds a photo from bytes picked in the browser (multi-file upload). */
  addFile: (name: string, bytes: Uint8Array | ArrayBuffer) =>
    bus.invoke(photoEvents.photos.addFile(name, bytes)),
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
  remove: (id: string, folderId?: string) => bus.invoke(photoEvents.photos.remove(id, folderId)),
  join: (key: string, name?: string) => bus.invoke(photoEvents.photos.join(key, name)),
  enroll: (key: string, name: string) => bus.invoke(photoEvents.photos.enroll(key, name)),
  status: () => bus.invoke(photoEvents.photos.status()),
  folders: () => bus.invoke(photoEvents.photos.folders()),
  createFolder: (name: string) => bus.invoke(photoEvents.photos.createFolder(name)),
  setActive: (folderId: string) => bus.invoke(photoEvents.photos.setActive(folderId)),
  setName: (name: string) => bus.invoke(photoEvents.photos.setName(name)),
  requests: () => bus.invoke(photoEvents.photos.requests()),
  respond: (folderId: string, requesterKey: string, approve: boolean) =>
    bus.invoke(photoEvents.photos.respond(folderId, requesterKey, approve)),
  removeMember: (folderId: string, memberKey: string) =>
    bus.invoke(photoEvents.photos.removeMember(folderId, memberKey)),
  /** Native-host pick/capture (`justus.media`): staged file paths. */
  media: {
    pickMany: () => bus.invoke(justusMediaEvents.media.pickMany()),
    capture: () => bus.invoke(justusMediaEvents.media.capture()),
  },
  logs: {
    view: (opts?: { tail?: number; level?: LogLevel; sources?: string[] }) =>
      bus.invoke(logEvents.view(opts)),
    clear: () => bus.invoke(logEvents.clear()),
  },
  grants: {
    view: () => bus.invoke(grantEvents.view()),
    grant: (peerId: string) => bus.invoke(grantEvents.grant(peerId)),
    decline: (peerId: string) => bus.invoke(grantEvents.decline(peerId)),
    revoke: (peerId: string) => bus.invoke(grantEvents.revoke(peerId)),
    snooze: () => bus.invoke(grantEvents.snooze()),
  },
};
