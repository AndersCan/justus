import { definePlugin } from "@ekrooh/bare/core";
import { lockSpecs } from "@justus/core";

/** `justus.lock` stub: declares the host-only lock events and has no
 * handlers, so the router delegates each invoke to the native host. */
export function createLockPluginStub() {
  return definePlugin("justus.lock", lockSpecs, { capabilities: ["lock"] });
}
