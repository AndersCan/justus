import c from "compact-encoding";
import Protomux from "protomux";

/** Protomux protocol carrying the sender's peer protocol number. Never renamed, never re-encoded. */
export const VERSION_PROTOCOL = "justus/version";

const MAX_VERSION = 1000;

/**
 * Tells the peer on `conn` which peer protocol we speak, and reports theirs.
 *
 * Call after `corestore.replicate(conn)` and before `greetPeer`, so a peer's
 * version message arrives before its identity greeting. A greeting with no
 * version before it comes from protocol 1. `0` and values above 1000 are
 * dropped as garbage.
 */
export function openVersion(
  conn: unknown,
  own: number,
  onVersion: (remote: number) => void,
  onIgnored: (remote: number) => void = () => {},
): void {
  const mux = Protomux.from(conn);
  let version: { send(n: number): boolean } | null = null;
  const channel = mux.createChannel({
    protocol: VERSION_PROTOCOL,
    unique: true,
    onopen() {
      version?.send(own);
    },
  });
  // Already open on this connection.
  if (!channel) return;
  version = channel.addMessage({
    encoding: c.uint,
    onmessage: (remote: number) => {
      if (remote === 0 || remote > MAX_VERSION) onIgnored(remote);
      else onVersion(remote);
    },
  });
  channel.open();
}
