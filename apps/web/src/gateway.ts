import { createPluginBus, createProtocolMessenger, MessageType } from "@ekrooh/bare/core";
import { photoEvents } from "@justus/core";
import { getTransport } from "./transport";

export const transport = getTransport();

export const messenger = createProtocolMessenger((request, payload) => {
  transport.send(MessageType.ENVELOPE, request, payload);
});

export const bus = createPluginBus(messenger);

/** The plugin-invoke shell the mantaq actors drive. Every call returns the
 * framework's `Either` tuple `[error, result]`. */
export const gateway = {
  list: () => bus.invoke(photoEvents.photos.list()),
  add: (path: string) => bus.invoke(photoEvents.photos.add(path)),
  /** Adds a photo from bytes picked in the browser (multi-file upload). */
  addFile: (name: string, bytes: Uint8Array | ArrayBuffer) =>
    bus.invoke(photoEvents.photos.addFile(name, bytes)),
  remove: (id: string) => bus.invoke(photoEvents.photos.remove(id)),
  join: (key: string) => bus.invoke(photoEvents.photos.join(key)),
  enroll: (key: string, name: string) => bus.invoke(photoEvents.photos.enroll(key, name)),
  status: () => bus.invoke(photoEvents.photos.status()),
  folders: () => bus.invoke(photoEvents.photos.folders()),
  createFolder: (name: string) => bus.invoke(photoEvents.photos.createFolder(name)),
  setActive: (folderId: string) => bus.invoke(photoEvents.photos.setActive(folderId)),
  setName: (name: string) => bus.invoke(photoEvents.photos.setName(name)),
  requests: () => bus.invoke(photoEvents.photos.requests()),
  respond: (folderId: string, requesterKey: string, approve: boolean) =>
    bus.invoke(photoEvents.photos.respond(folderId, requesterKey, approve)),
};
