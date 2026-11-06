import c from "compact-encoding";
import Protomux from "protomux";
import type { Answer } from "../membership/records.ts";

/** Protomux protocol carrying an Admin's answer to a join ask. */
export const ANSWER_PROTOCOL = "justus/answer/v1";

/**
 * Opens the answer channel on `conn` (call after `corestore.replicate(conn)` so
 * both share one muxer). `onAnswer` gets the raw decoded value: the caller
 * validates it with `parseAnswer` and ties it to the connection's identity.
 * `send` returns false when the channel is not open yet or is closed.
 */
export function openAnswers(
  conn: unknown,
  onAnswer: (value: unknown) => void,
): { send(answer: Answer): boolean } {
  const mux = Protomux.from(conn);
  let message: { send(value: unknown): boolean } | null = null;
  let open = false;
  const channel = mux.createChannel({
    protocol: ANSWER_PROTOCOL,
    unique: true,
    onopen() {
      open = true;
    },
    onclose() {
      open = false;
    },
  });
  // Already open on this connection.
  if (!channel) return { send: () => false };
  message = channel.addMessage({
    encoding: c.json,
    onmessage: (value: unknown) => onAnswer(value),
  });
  channel.open();
  return { send: (answer) => open && message !== null && message.send(answer) };
}
