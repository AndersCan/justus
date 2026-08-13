import { dispatchEvent, invokeEvent, type EventSpec, type InvokeEnvelope } from "@ekrooh/bare/core";
import type { Photo, PhotoChanged, SyncStatus } from "./types";

/** Importing a photo file (read + spool + put) can take a while. */
const PHOTOS_ADD_TIMEOUT_MS = 120_000;

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
    args: {} as { path: string },
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
      return invokeEvent(photoSpecs.list, {});
    },
    add(path: string): InvokeEnvelope<"photos.add", { path: string }, Photo> {
      return invokeEvent(photoSpecs.add, { path }, null, PHOTOS_ADD_TIMEOUT_MS);
    },
    remove(id: string): InvokeEnvelope<"photos.remove", { id: string }, { id: string }> {
      return invokeEvent(photoSpecs.remove, { id });
    },
    join(key: string): InvokeEnvelope<"photos.join", { key: string }, SyncStatus> {
      return invokeEvent(photoSpecs.join, { key });
    },
    enroll(
      key: string,
      name: string,
    ): InvokeEnvelope<"photos.enroll", { key: string; name: string }, SyncStatus> {
      return invokeEvent(photoSpecs.enroll, { key, name });
    },
    status(): InvokeEnvelope<"photos.status", Record<string, never>, SyncStatus> {
      return invokeEvent(photoSpecs.status, {});
    },
  },
} as const;

/** Dispatch envelope for the backend → web `photos.changed` push. The web
 * layer subscribes to the transport and matches this header shape; this
 * builder is also used by the backend to construct the frame. */
export function photoChangedEnvelope(change: PhotoChanged) {
  return dispatchEvent(photoSpecs.changed, change);
}
