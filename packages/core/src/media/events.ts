import { invokeEvent, type EventSpec, type InvokeEnvelope } from "@ekrooh/bare/core";

/** One file the native host picked or captured, staged where the worklet may
 * import it (`photos.add(path)`); `name` is the original display name. */
export type PickedMedia = { path: string; name?: string };

/** Pickers wait on the user; give them as long as ekrooh's `vendor.media`. */
const MEDIA_TIMEOUT_MS = 300_000;

/** Most photos one pick may return (each is staged on the device first). */
export const MAX_PICK = 50;

/**
 * `justus.media` — host-only pick/capture that hands back staged file paths.
 * The worklet registers a stub (no handlers) so the router delegates the
 * invoke to the native host. Ekrooh's own `vendor.media` answers with a
 * mounted URL only and picks one item; Justus needs paths, and many of them.
 */
export const mediaSpecs = {
  pickMany: {
    pluginId: "justus.media",
    name: "media.pickMany",
    args: {} as { kind?: "image" | "video"; limit?: number },
    result: {} as { items: PickedMedia[] },
  },
  capture: {
    pluginId: "justus.media",
    name: "media.capture",
    args: {} as { kind?: "image" | "video" },
    result: {} as PickedMedia,
  },
} as const satisfies Record<string, EventSpec<any, any>>;

export const justusMediaEvents = {
  media: {
    pickMany(
      limit = MAX_PICK,
    ): InvokeEnvelope<
      "media.pickMany",
      { kind?: "image" | "video"; limit?: number },
      { items: PickedMedia[] }
    > {
      return invokeEvent(mediaSpecs.pickMany, { kind: "image", limit }, null, MEDIA_TIMEOUT_MS);
    },
    capture(): InvokeEnvelope<"media.capture", { kind?: "image" | "video" }, PickedMedia> {
      return invokeEvent(mediaSpecs.capture, { kind: "image" }, null, MEDIA_TIMEOUT_MS);
    },
  },
};
