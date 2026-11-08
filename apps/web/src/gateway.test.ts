import { describe, it, expect, vi } from "vite-plus/test";
import type { WireMessage } from "@ekrooh/bare/core";

const listeners = new Set<(message: WireMessage) => void>();
const sent: { requestId?: string; event?: string }[] = [];

vi.mock("./transport", () => ({
  getTransport: () => ({
    send: (_type: unknown, header: { requestId?: string; event?: string }) => sent.push(header),
    subscribe: (listener: (message: WireMessage) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  }),
}));

describe("gateway", () => {
  it("listens for replies as soon as it loads, before main.ts runs", async () => {
    const { gateway } = await import("./gateway");
    expect(listeners.size).toBe(1);
    const reply = gateway.friends.list();
    const { requestId, event } = sent[0];
    const message = {
      header: {
        type: "INVOKE_RESPONSE",
        pluginId: "justus.friends",
        event,
        requestId,
        result: { friends: [] },
      },
    } as unknown as WireMessage;
    for (const listener of listeners) listener(message);
    const [error, result] = await reply;
    expect(error).toBeNull();
    expect(result).toEqual({ friends: [] });
  });
});
