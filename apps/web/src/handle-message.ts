import type { WireMessage } from "@ekrooh/bare/core";
import { photoSpecs } from "@justus/core";
import { $lastSyncAt, gallery } from "./machines/gallery-machine";
import { sync } from "./machines/sync-machine";

/** Routes inbound wire messages: backend→web pushes refresh the actors;
 * invoke failures log. */
export function handleMessage(msg: WireMessage) {
  const h = msg.header;
  const changed = photoSpecs.changed;
  if (h.type === "DISPATCH" && h.pluginId === changed.pluginId && h.event === changed.name) {
    $lastSyncAt.set(Date.now());
    gallery.load();
    sync.refresh();
  } else if (h.type === "INVOKE_RESPONSE" && h.error) {
    console.error("Plugin invoke failed:", h.pluginId, h.event, h.error.message);
  }
}
