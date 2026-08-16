import { invokeEvent, type EventSpec, type InvokeEnvelope } from "@ekrooh/bare/core";
import type { Photo, PhotoChanged, SyncStatus } from "./types";

/** Importing a photo file (read + spool + put) can take a while. */
const PHOTOS_ADD_TIMEOUT_MS = 120_000;
/** list/status spool remote photos on first load — network pulls can be slow. */
const PHOTOS_LIST_TIMEOUT_MS = 30_000;
/** join waits for a peer handshake; give it a generous window. */
const PHOTOS_JOIN_TIMEOUT_MS = 60_000;
/** remove/enroll touch local drives — still, don't be stingy. */
const PHOTOS_SHORT_TIMEOUT_MS = 15_000;

export const photoSpecs = {
  list: {
    pluginId: "justus.photos",
    name: "photos.list",
    args: {} as Record<string, never>,
    result: {} as { photos: Photo[] },
  },
  add: {
    pluginId: "justus.photos",
    name: "photos.add",
    // Either `path` (a file the host picked, already on disk) or `name`
    // (the original file name when the bytes travel in-band as the invoke
    // payload). The plugin picks whichever the caller provided.
    args: {} as { path?: string; name?: string },
    result: {} as Photo,
  },
  remove: {
    pluginId: "justus.photos",
    name: "photos.remove",
    args: {} as { id: string },
    result: {} as { id: string },
  },
  join: {
    pluginId: "justus.photos",
    name: "photos.join",
    args: {} as { key: string },
    result: {} as SyncStatus,
  },
  enroll: {
    pluginId: "justus.photos",
    name: "photos.enroll",
    args: {} as { key: string; name: string },
    result: {} as SyncStatus,
  },
  status: {
    pluginId: "justus.photos",
    name: "photos.status",
    args: {} as Record<string, never>,
    result: {} as SyncStatus,
  },
  changed: {
    pluginId: "justus.photos",
    name: "photos.changed",
    args: {} as PhotoChanged,
    result: {} as never,
  },
} as const satisfies Record<string, EventSpec<any, any>>;

export const photoEvents = {
  photos: {
    list(): InvokeEnvelope<"photos.list", Record<string, never>, { photos: Photo[] }> {
      return invokeEvent(photoSpecs.list, {}, null, PHOTOS_LIST_TIMEOUT_MS);
    },
    add(path: string): InvokeEnvelope<"photos.add", { path?: string; name?: string }, Photo> {
      return invokeEvent(photoSpecs.add, { path }, null, PHOTOS_ADD_TIMEOUT_MS);
    },
    /** Adds a photo whose bytes travel in-band as the invoke payload (the
     * browser multi-file picker — no host path exists there). */
    addFile(
      name: string,
      bytes: Uint8Array | ArrayBuffer,
    ): InvokeEnvelope<"photos.add", { path?: string; name?: string }, Photo> {
      return invokeEvent(photoSpecs.add, { name }, bytes, PHOTOS_ADD_TIMEOUT_MS);
    },
    remove(id: string): InvokeEnvelope<"photos.remove", { id: string }, { id: string }> {
      return invokeEvent(photoSpecs.remove, { id }, null, PHOTOS_SHORT_TIMEOUT_MS);
    },
    join(key: string): InvokeEnvelope<"photos.join", { key: string }, SyncStatus> {
      return invokeEvent(photoSpecs.join, { key }, null, PHOTOS_JOIN_TIMEOUT_MS);
    },
    enroll(
      key: string,
      name: string,
    ): InvokeEnvelope<"photos.enroll", { key: string; name: string }, SyncStatus> {
      return invokeEvent(photoSpecs.enroll, { key, name }, null, PHOTOS_SHORT_TIMEOUT_MS);
    },
    status(): InvokeEnvelope<"photos.status", Record<string, never>, SyncStatus> {
      return invokeEvent(photoSpecs.status, {}, null, PHOTOS_LIST_TIMEOUT_MS);
    },
  },
} as const;
