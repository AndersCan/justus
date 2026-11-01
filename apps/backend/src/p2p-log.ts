/**
 * Structured p2p boundary events (#200). One line per event, greppable from
 * `/__logs` or backend.log, so a field bug can be diagnosed from logs alone:
 *
 *   [p2p] conn.open conn=3 noise=ab12cd34 initiator=true
 *
 * Format: `[p2p] <event> key=value ...`. Keys, topics and folder ids are cut to
 * their first 8 hex chars ({@link short}); `conn` is a per-store, monotonic
 * connection id that joins `conn.*`, `identity.learned` and presence lines.
 *
 * Events:
 *   conn.open conn noise initiator        swarm connection established
 *   conn.close conn noise ms              swarm connection ended
 *   conn.error conn noise err             socket error (connection stays tracked until close)
 *   identity.learned conn identity new    peer told us its identity drive (conn -> identity)
 *   topic.join topic served               first join of a swarm topic
 *   topic.upgrade topic                   client-only topic now also announced
 *   topic.leave topic                     topic released
 *   topic.flushed topic ms                DHT announce/lookup round finished
 *   rediscover.attempt drive topic n      re-ran a lookup because the drive has no peer
 *   rediscover.giveup drive topic         backoff exhausted; Hyperswarm's 10-minute refresh remains
 *   drive.open.start drive                remote drive open begun
 *   drive.open.ready drive ms peers       remote drive ready
 *   drive.open.timeout drive ms err       remote drive never became ready
 *   drive.change drive length folder      drive index appended/truncated (replication or local)
 *   swarmkey.learned member swarmkey      member's noise key read from /device.json
 *   swarmkey.changed member from to       the member's noise key differs from the cached one
 *   requests.found folder count peers     request inbox read N requests off peers' outboxes
 *   presence.change swarmkey member state conns   a member's reachability flipped (up/down)
 *   error where err ...                   a network/drive operation failed (formerly swallowed)
 *
 * Tests inject {@link P2pLogSink} via `deps.log` to assert on events.
 */
export type P2pFields = Record<string, string | number | boolean | undefined>;
export type P2pEvent = { event: string; fields: P2pFields };
export type P2pLogSink = (e: P2pEvent) => void;
export type P2pLog = (event: string, fields?: P2pFields) => void;

/** First 8 hex chars of a key, enough to correlate lines without noise. */
export function short(key: Uint8Array | string | undefined | null): string | undefined {
  if (!key) return undefined;
  const s = typeof key === "string" ? key : Buffer.from(key).toString("hex");
  return s.slice(0, 8);
}

export function formatP2pEvent({ event, fields }: P2pEvent): string {
  const parts = [`[p2p] ${event}`];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    const text = String(v);
    parts.push(`${k}=${/[\s"=]/.test(text) ? JSON.stringify(text) : text}`);
  }
  return parts.join(" ");
}

/** Default sink: a console line, which the log collector captures. */
export const consoleSink: P2pLogSink = (e) => {
  console.log(formatP2pEvent(e));
};

export function createP2pLog(sink: P2pLogSink = consoleSink): P2pLog {
  return (event, fields = {}) => {
    try {
      sink({ event, fields });
    } catch {
      // Logging must never break a p2p operation.
    }
  };
}

export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
