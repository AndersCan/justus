import { invokeEvent, type EventSpec, type InvokeEnvelope } from "@ekrooh/bare/core";

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
