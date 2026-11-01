/**
 * The peer network boundary (#200): everything the app needs from Hyperswarm
 * and the identity greeting, and nothing else. Keys and topics are lowercase
 * hex strings. Replicating drives over a connection is the adapter's
 * `replicate` dependency, wired by the composition root; it is not part of
 * this port.
 */
export type PeerEvent =
  /** `peerKey` is the peer's per-boot noise key, never a drive key. */
  | { type: "connected"; conn: number; peerKey: string; initiator: boolean }
  /** The peer told us its identity drive key on connection `conn`. */
  | { type: "identified"; conn: number; identityKey: string }
  | { type: "disconnected"; conn: number; peerKey: string };

export type PeerNetwork = {
  /** Own noise key. A new one every boot. */
  peerKey(): string;
  /** Starts greeting peers with `identityKey` and reporting connections. Call once, before joining topics. */
  start(identityKey: string, onEvent: (e: PeerEvent) => void): void;
  /** Idempotent. Joining a client-only topic again with `server: true` starts announcing it. */
  join(topic: string, opts: { server: boolean }): void;
  /** Idempotent. */
  leave(topic: string): void;
  /**
   * Re-runs the topic lookup with backoff until `hasPeer()` is true, because
   * Hyperswarm only looks a topic up again every 10 minutes.
   */
  findPeers(topic: string, hasPeer: () => boolean): void;
  connectionCount(): number;
  debug(): Record<string, unknown>;
  close(): Promise<void>;
};
