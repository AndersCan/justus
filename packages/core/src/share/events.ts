import { invokeEvent, type EventSpec, type InvokeEnvelope } from "@ekrooh/bare/core";
import type { SharedBatch } from "./inbox";

/**
 * `justus.share` — host-only system share sheet. The worklet registers a stub
 * (no handlers) so the router delegates the invoke to the native host. The host
 * answers `{ shown: true }` once the sheet is on screen and fails only when it
 * could not show it; closing the sheet is not reported.
 */
export const shareSpecs = {
  send: {
    pluginId: "justus.share",
    name: "share.send",
    args: {} as { text: string },
    result: {} as { shown: true },
  },
} as const satisfies Record<string, EventSpec<any, any>>;

export const justusShareEvents = {
  share: {
    send(text: string): InvokeEnvelope<"share.send", { text: string }, { shown: true }> {
      return invokeEvent(shareSpecs.send, { text });
    },
  },
};

/** Local file listing: fast. */
const SHARED_IN_TIMEOUT_MS = 5_000;

/** `justus.sharedIn` — photos other apps shared to Justus, waiting in the inbox. Local, never replicated. */
export const sharedInSpecs = {
  list: {
    pluginId: "justus.sharedIn",
    name: "sharedIn.list",
    args: {} as Record<string, never>,
    result: {} as { batches: SharedBatch[] },
  },
} as const satisfies Record<string, EventSpec<any, any>>;

export const sharedInEvents = {
  list() {
    return invokeEvent(sharedInSpecs.list, {}, null, SHARED_IN_TIMEOUT_MS);
  },
};
