import { describe, it, expect } from "vite-plus/test";
import { MessageType, type WireMessage } from "@ekrooh/bare/core";
import { createMockTransport } from "@ekrooh/bare/transports";
import { withMockReplies } from "./transport";

function replies(event: string) {
  const transport = withMockReplies(createMockTransport());
  const got: WireMessage[] = [];
  transport.subscribe((m: WireMessage) => got.push(m));
  transport.send(
    MessageType.ENVELOPE,
    { type: "INVOKE_REQUEST", pluginId: "x", event, requestId: "r1", args: {} } as never,
    new Uint8Array(0),
  );
  return new Promise<WireMessage[]>((resolve) => setTimeout(() => resolve(got), 10));
}

describe("withMockReplies", () => {
  it("answers friends.list with nobody saved", async () => {
    const [m] = await replies("friends.list");
    const h = m.header as unknown as { requestId: string; result: unknown; error?: unknown };
    expect(h.requestId).toBe("r1");
    expect(h.result).toEqual({ friends: [] });
    expect(h.error).toBeUndefined();
  });

  it("answers seen.read with an empty record", async () => {
    const [m] = await replies("seen.read");
    const h = m.header as unknown as { result: unknown };
    expect(h.result).toEqual({ seen: { version: 1, known: {} } });
  });

  it("answers seen.write with an empty result", async () => {
    const [m] = await replies("seen.write");
    expect((m.header as unknown as { result: unknown }).result).toEqual({});
  });

  it("leaves other events to the mock", async () => {
    const [m] = await replies("nope.unknown");
    expect((m.header as unknown as { error?: unknown }).error).toBeDefined();
  });
});
