import { definePlugin } from "@ekrooh/bare/core";
import { mediaSpecs } from "@justus/core";

/** `justus.media` stub: declares the host-only pick/capture events and has no
 * handlers, so the router delegates each invoke to the native host (the same
 * shape as ekrooh's `core.permissions` stub). */
export function createMediaPluginStub() {
  return definePlugin("justus.media", mediaSpecs, { capabilities: ["media"] });
}
