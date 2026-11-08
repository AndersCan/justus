import { describe, it, expect } from "vite-plus/test";
import { MessageType, type WireMessage } from "@ekrooh/bare/core";
import { createMockTransport } from "@ekrooh/bare/transports";
import { withMockFriends } from "./transport";

function replies(event: string) {
  const transport = withMockFriends(createMockTransport());
  const got: WireMessage[] = [];
  transport.subscribe((m: WireMessage) => got.push(m));
  transport.send(
    MessageType.ENVELOPE,
    { type: "INVOKE_REQUEST", pluginId: "x", event, requestId: "r1", args: {} } as never,
    new Uint8Array(0),
  );
  return new Promise<WireMessage[]>((resolve) => setTimeout(() => resolve(got), 10));
}

describe("withMockFriends", () => {
  it("answers friends.list with nobody saved", async () => {
    const [m] = await replies("friends.list");
    const h = m.header as unknown as { requestId: string; result: unknown; error?: unknown };
    expect(h.requestId).toBe("r1");
    expect(h.result).toEqual({ friends: [] });
    expect(h.error).toBeUndefined();
  });

  it("leaves other events to the mock", async () => {
    const [m] = await replies("nope.unknown");
    expect((m.header as unknown as { error?: unknown }).error).toBeDefined();
  });
});
