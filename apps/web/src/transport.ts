import {
  createMockTransport,
  createWebSocketTransport,
  type MessageTransport,
} from "@ekrooh/bare/transports";

let transport: MessageTransport | null = null;

export function getTransport(): MessageTransport {
  if (transport) return transport;

  if (import.meta.env.VITE_TRANSPORT_MODE === "mock") {
    transport = createMockTransport();
    return transport;
  }

  // On-device the page is served by the worklet's loopback server, so the
  // transport defaults to the same origin. Browser dev is cross-origin (the
  // Vite dev server), so point at the dev backend explicitly.
  const devUrl =
    import.meta.env.VITE_BARE_WS_URL ?? (import.meta.env.DEV ? "ws://127.0.0.1:8080" : undefined);
  transport = createWebSocketTransport(devUrl ? { url: devUrl } : {});

  return transport;
}
