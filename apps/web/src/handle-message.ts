import type { WireMessage } from "@ekrooh/bare/core";
import { photoSpecs } from "@justus/core";
import { folders } from "./machines/folders-machine";
import { $lastSyncAt, gallery } from "./machines/gallery-machine";
import { requests } from "./machines/requests-machine";
import { sync } from "./machines/sync-machine";

/** The `cause` carried in a `photos.changed` dispatch, if any. */
export function changeCause(header: unknown): string | undefined {
  const args = (header as { args?: { cause?: unknown } }).args;
  return typeof args?.cause === "string" ? args.cause : undefined;
}

/** Routes inbound wire messages: backend→web pushes refresh the actors;
 * invoke failures log. */
export function handleMessage(msg: WireMessage) {
  const h = msg.header;
  const changed = photoSpecs.changed;
  if (h.type === "DISPATCH" && h.pluginId === changed.pluginId && h.event === changed.name) {
    // A presence change only moves the member list; skip the heavy reloads.
    if (changeCause(h) === "presence") {
      sync.refresh();
      return;
    }
    $lastSyncAt.set(Date.now());
    gallery.load();
    sync.refresh();
    folders.refresh();
    requests.refresh();
  } else if (h.type === "INVOKE_RESPONSE" && h.error) {
    console.error("Plugin invoke failed:", h.pluginId, h.event, h.error.message);
  }
}
