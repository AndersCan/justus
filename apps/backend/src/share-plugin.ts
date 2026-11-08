import { definePlugin } from "@ekrooh/bare/core";
import { shareSpecs } from "@justus/core";

/** `justus.share` stub: declares the host-only share event and has no
 * handlers, so the router delegates each invoke to the native host. */
export function createSharePluginStub() {
  return definePlugin("justus.share", shareSpecs, { capabilities: ["share"] });
}
