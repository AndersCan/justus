import type { WireMessage } from "@ekrooh/bare/core";
import { gallery } from "./machines/gallery-machine";
import { sync } from "./machines/sync-machine";

/** Routes inbound wire messages: backend→web pushes refresh the actors;
 * invoke failures log. */
export function handleMessage(msg: WireMessage) {
  const h = msg.header;
  if (h.type === "DISPATCH" && h.pluginId === "justus.photos" && h.event === "photos.changed") {
    gallery.load();
    sync.refresh();
  } else if (h.type === "INVOKE_RESPONSE" && h.error) {
    console.error("Plugin invoke failed:", h.pluginId, h.event, h.error.message);
  }
}
