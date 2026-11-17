import { devPeerPort } from "./utils/peer";
import { MessageType } from "@ekrooh/bare/core";
import { emptySeen } from "@justus/core";
import {
  createMockTransport,
  createWebSocketTransport,
  type MessageTransport,
} from "@ekrooh/bare/transports";

let transport: MessageTransport | null = null;

/** Canned replies for the events the page sends on start. The mock transport
 * refuses events it has no handler for, so the docs site's mock answers these
 * with nothing saved instead of an error the page would log. */
const mockReplies: Record<string, unknown> = {
  "friends.list": { friends: [] },
  "seen.read": { seen: emptySeen() },
  "seen.write": {},
};

export function withMockReplies(inner: MessageTransport): MessageTransport {
  const listeners = new Set<Parameters<MessageTransport["subscribe"]>[0]>();
  inner.subscribe((message) => {
    for (const listener of listeners) listener(message);
  });
  return {
    ...inner,
    send(type, header, payload) {
      const h = header as { type?: string; event?: string; pluginId?: string; requestId?: string };
      if (
        type === MessageType.ENVELOPE &&
        h.type === "INVOKE_REQUEST" &&
        h.event !== undefined &&
        Object.hasOwn(mockReplies, h.event)
      ) {
        const result = mockReplies[h.event];
        queueMicrotask(() => {
          const reply = {
            type: MessageType.ENVELOPE,
            header: {
              type: "INVOKE_RESPONSE",
              pluginId: h.pluginId,
              event: h.event,
              requestId: h.requestId,
              result,
            },
            payload: new Uint8Array(0),
          };
          for (const listener of listeners) listener(reply as never);
        });
        return;
      }
      inner.send(type, header, payload);
    },
    subscribe(handler) {
      listeners.add(handler);
      return () => {
        listeners.delete(handler);
      };
    },
  };
}

export function getTransport(): MessageTransport {
  if (transport) return transport;

  if (import.meta.env.VITE_TRANSPORT_MODE === "mock") {
    transport = withMockReplies(createMockTransport());
    return transport;
  }

  // On-device the page is served by the worklet's loopback server, so the
  // transport defaults to the same origin. Browser dev is cross-origin (the
  // Vite dev server), so point at the dev backend explicitly.
  const devUrl =
    import.meta.env.VITE_BARE_WS_URL ??
    (import.meta.env.DEV ? `ws://127.0.0.1:${devPeerPort()}` : undefined);
  transport = createWebSocketTransport(devUrl ? { url: devUrl } : {});

  return transport;
}
