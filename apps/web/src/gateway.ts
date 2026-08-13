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
  remove: (id: string) => bus.invoke(photoEvents.photos.remove(id)),
  join: (key: string) => bus.invoke(photoEvents.photos.join(key)),
  enroll: (key: string, name: string) => bus.invoke(photoEvents.photos.enroll(key, name)),
  status: () => bus.invoke(photoEvents.photos.status()),
};
