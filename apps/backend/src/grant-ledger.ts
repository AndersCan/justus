/**
 * Per-device grant ledger — the local source of truth for who this device
 * serves photos to (and who serves to it). It is intentionally NEVER
 * replicated: the social graph must not leak to album/topic holders. This is
 * the first slice of issue #30 (see docs/design/share-grant-spec.md §1); the
 * share surface (#25) and the serve-gate that actually stops replication (#29)
 * build on top of it.
 *
 * The module is pure: no Bare imports, so it loads and tests under Node without
 * a runtime. Durability is injected through {@link LedgerStore}, exactly like
 * `PhotoStoreDeps` in `photo-store.ts`.
 */

export type GrantState = "granted" | "revoked" | "declined" | "undecided";

export type GrantRecord = {
  peerId: string;
  serveTo: GrantState;
  /** Peer we receive from, when this device was invited into their album. */
  serveFrom?: string;
  /** Peer that sent the invite receipt (the inviter auto-shares to us). */
  invitedBy?: string;
  /** Verified invite receipt payload. Presence marks the peer as known. */
  receipt?: string;
  /** Volatile runtime presence — not persisted (re-derived each session). */
  online?: boolean;
  lastSeenAt?: number;
  /** Set the first time a peer is seen holding our content without a receipt;
   * drives the once-daily unknown-holder prompt. */
  unknownHolderSince?: number;
  /** Decline is terminal: the prompt never re-shows for this peer. */
  declinedTerminal?: boolean;
  lastChangedAt: number;
};

export type LedgerEvent =
  | { type: "GRANTED"; peerId: string; at: number }
  | { type: "REVOKED"; peerId: string; at: number }
  | { type: "DECLINED"; peerId: string; at: number }
  | { type: "UNKNOWN_HOLDER"; peerId: string; at: number }
  | { type: "RECEIPT_VERIFIED"; peerId: string; at: number };

/** Pluggable durability. Production backs this with the device drive; tests
 * use an in-memory array (see test/grant-ledger.test.ts). */
export interface LedgerStore {
  read(): Promise<GrantRecord[]>;
  write(records: GrantRecord[]): Promise<void>;
}

export type GrantLedgerOptions = {
  store: LedgerStore;
  now?: () => number;
};

export class GrantLedger {
  private readonly records = new Map<string, GrantRecord>();
  private readonly listeners = new Set<(event: LedgerEvent) => void>();
  private loaded = false;
  private readonly opts: GrantLedgerOptions;
  private readonly now: () => number;

  constructor(opts: GrantLedgerOptions) {
    this.opts = opts;
    this.now = opts.now ?? (() => Date.now());
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    const stored = await this.opts.store.read();
    this.records.clear();
    for (const record of stored) {
      // Presence is volatile; never trust a persisted value.
      this.records.set(record.peerId, { ...record, online: undefined });
    }
    this.loaded = true;
  }

  /** Subscribe to ledger changes. Returns an unsubscribe function. */
  on(handler: (event: LedgerEvent) => void): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  private emit(event: LedgerEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private async commit(record: GrantRecord): Promise<void> {
    this.records.set(record.peerId, record);
    await this.opts.store.write([...this.records.values()]);
  }

  getState(peerId: string): GrantRecord {
    const existing = this.records.get(peerId);
    if (existing) return existing;
    return { peerId, serveTo: "undecided", lastChangedAt: 0 };
  }

  list(): GrantRecord[] {
    return [...this.records.values()];
  }

  /** A verified invite receipt auto-shares the inviter's album (issue #30).
   * Crypto verification lives in the pairing flow; here the receipt is already
   * trusted and simply recorded + granted. */
  async verifyReceipt(peerId: string, opts: { receipt: string }): Promise<GrantRecord> {
    const changedAt = this.now();
    const record: GrantRecord = {
      ...this.getState(peerId),
      peerId,
      serveTo: "granted",
      receipt: opts.receipt,
      invitedBy: this.getState(peerId).invitedBy ?? peerId,
      unknownHolderSince: undefined,
      declinedTerminal: false,
      lastChangedAt: changedAt,
    };
    await this.commit(record);
    this.emit({ type: "RECEIPT_VERIFIED", peerId, at: changedAt });
    this.emit({ type: "GRANTED", peerId, at: changedAt });
    return record;
  }

  async grant(peerId: string): Promise<GrantRecord> {
    const changedAt = this.now();
    const record: GrantRecord = {
      ...this.getState(peerId),
      peerId,
      serveTo: "granted",
      unknownHolderSince: undefined,
      declinedTerminal: false,
      lastChangedAt: changedAt,
    };
    await this.commit(record);
    this.emit({ type: "GRANTED", peerId, at: changedAt });
    return record;
  }

  /** Revoke is reversible and observable. We never delete the record — the
   * "no erasure implication" rule (share-grant-spec §2.1) means the peer keeps
   * what they already have; they just stop getting new photos. */
  async revoke(peerId: string): Promise<GrantRecord> {
    const changedAt = this.now();
    const record: GrantRecord = {
      ...this.getState(peerId),
      peerId,
      serveTo: "revoked",
      declinedTerminal: false,
      lastChangedAt: changedAt,
    };
    await this.commit(record);
    this.emit({ type: "REVOKED", peerId, at: changedAt });
    return record;
  }

  /** Decline is terminal: the unknown-holder prompt never re-shows (#30 AC).
   * Reversible only by a fresh invite re-running the flow. */
  async decline(peerId: string): Promise<GrantRecord> {
    const changedAt = this.now();
    const record: GrantRecord = {
      ...this.getState(peerId),
      peerId,
      serveTo: "declined",
      declinedTerminal: true,
      lastChangedAt: changedAt,
    };
    await this.commit(record);
    this.emit({ type: "DECLINED", peerId, at: changedAt });
    return record;
  }

  /** A peer holds our album content but has no valid receipt — the unknown
   * holder case (#30). Records it once (idempotent) so the once-daily prompt
   * can be batched. Known peers (granted/revoked/declined) and already-queued
   * holders are left untouched. */
  async recordUnknownHolder(peerId: string): Promise<GrantRecord> {
    const existing = this.records.get(peerId);
    if (existing?.declinedTerminal) return existing;
    if (existing && existing.serveTo !== "undecided") return existing;
    if (existing?.unknownHolderSince) return existing;
    const changedAt = this.now();
    const record: GrantRecord = {
      peerId,
      serveTo: "undecided",
      unknownHolderSince: changedAt,
      lastChangedAt: changedAt,
    };
    await this.commit(record);
    this.emit({ type: "UNKNOWN_HOLDER", peerId, at: changedAt });
    return record;
  }

  /** Volatile presence — updated in memory only, not persisted. */
  setPresence(peerId: string, presence: { online: boolean }): void {
    const existing = this.records.get(peerId);
    if (!existing) return;
    existing.online = presence.online;
    existing.lastSeenAt = presence.online ? this.now() : existing.lastSeenAt;
  }
}
