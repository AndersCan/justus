import { MessageType, createProtocolMessenger } from "@ekrooh/bare/core";
import { createWebSocketTransport } from "@ekrooh/bare/transports";

/** Dev probe: invoke a justus.photos event over the loopback WS and print the
 * response. Usage: node scripts/dev-invoke.mjs <event> [jsonArgs] */

const event = process.argv[2] ?? "photos.status";
const args = process.argv[3] ? JSON.parse(process.argv[3]) : {};
const url = process.env.JUSTUS_WS_URL ?? "ws://localhost:8080";

const transport = createWebSocketTransport(url);
const messenger = createProtocolMessenger((request, payload) => {
  transport.send(MessageType.ENVELOPE, request, payload);
});
transport.subscribe((message) => messenger.handleIncoming(message.header));

const header = { type: "INVOKE_REQUEST", pluginId: "justus.photos", event, args };
try {
  const response = await messenger.invoke(header, null, 30_000);
  if (response?.error) {
    console.log(`ERROR ${response.error.code}: ${response.error.message}`);
    process.exit(1);
  }
  console.log(JSON.stringify(response?.result ?? null, null, 2));
  process.exit(0);
} catch (err) {
  console.log(`INVOKE FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
