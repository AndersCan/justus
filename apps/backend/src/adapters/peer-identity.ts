import c from "compact-encoding";
import Protomux from "protomux";

/** Protomux protocol carrying each device's identity drive key. */
export const IDENTITY_PROTOCOL = "justus/identity/v1";

/**
 * Tells the peer on `conn` which identity drive is ours, and reports theirs.
 *
 * A swarm connection names a peer by its noise key, which is random per boot
 * and is not a drive. An Admin reads join requests off the requester's
 * identity drive (`/requests.json`), so it needs that drive's key: each side
 * sends it on a dedicated channel, multiplexed next to hypercore replication
 * (call after `corestore.replicate(conn)` so both share one muxer).
 */
export function greetPeer(
  conn: unknown,
  ownIdentity: Uint8Array,
  onIdentity: (key: Uint8Array) => void,
): void {
  const mux = Protomux.from(conn);
  let identity: { send(key: Uint8Array): boolean } | null = null;
  const channel = mux.createChannel({
    protocol: IDENTITY_PROTOCOL,
    unique: true,
    onopen() {
      identity?.send(ownIdentity);
    },
  });
  // Already greeted on this connection.
  if (!channel) return;
  identity = channel.addMessage({
    encoding: c.fixed32,
    onmessage: (key: Uint8Array) => onIdentity(key),
  });
  channel.open();
}
