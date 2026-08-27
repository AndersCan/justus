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

import type { GrantState, GrantRecord } from "@justus/core";
export type { GrantState, GrantRecord };
import { issueInvite, verifyInvite, type InviteCrypto } from "./invite-receipt";

/** Milliseconds per calendar day, used to bucket prompts into "once daily". */
const DAY_MS = 24 * 60 * 60 * 1000;

function dayOf(epochMs: number): number {
  return Math.floor(epochMs / DAY_MS);
}

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
  /**
   * Ed25519 signing/verification for invite receipts (issue #30 signed-receipts).
   * When present, `verifyReceipt` checks the signature and only grants a verified
   * inviter; a missing or invalid receipt is treated as an unknown holder. When
   * absent (e.g. a test ledger), the legacy trusting behaviour is kept so existing
   * callers are unaffected. Production injects a bare-crypto adapter — see
   * main.core.ts.
   */
  crypto?: InviteCrypto;
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

  /**
   * Issue a signed invite receipt (issue #30 signed-receipts) for `inviteeId` to
   * share `albumId`. Returns the serialised receipt to hand to the invitee. Needs
   * the `crypto` option; throws if it was not configured.
   */
  issueInvite(args: { inviteeId: string; albumId: string }): string {
    if (!this.opts.crypto) {
      throw new Error("GrantLedger.issueInvite requires crypto to be configured");
    }
    return issueInvite(this.opts.crypto, args);
  }

  /**
   * Verify a signed invite receipt and auto-share the inviter's album (issue #30).
   * With `crypto` configured, the receipt's signature is checked against the
   * inviter's public key carried in the receipt, and the grant is recorded with
   * `invitedBy` set to the verified inviter. A malformed, mis-addressed, or
   * failing-signature receipt is treated as an unknown holder — never a silent
   * grant. Without `crypto` (legacy/test path) the opaque receipt is trusted as
   * before.
   */
  async verifyReceipt(peerId: string, opts: { receipt: string }): Promise<GrantRecord> {
    if (!this.opts.crypto) {
      return this.grantViaReceipt(peerId, opts.receipt, this.getState(peerId).invitedBy ?? peerId);
    }
    const verified = verifyInvite(this.opts.crypto, opts.receipt, peerId);
    if (!verified.ok) {
      // Missing or invalid receipt → unknown caller, not a grant.
      return this.recordUnknownHolder(peerId);
    }
    return this.grantViaReceipt(peerId, opts.receipt, verified.inviterId);
  }

  /** Shared commit + emit for a receipt-backed grant (verified or legacy). */
  private async grantViaReceipt(
    peerId: string,
    receipt: string,
    invitedBy: string,
  ): Promise<GrantRecord> {
    const changedAt = this.now();
    const record: GrantRecord = {
      ...this.getState(peerId),
      peerId,
      serveTo: "granted",
      receipt,
      invitedBy,
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

  /**
   * Unknown-holder peers whose prompt is due right now (issue #30 §2.2). A peer
   * is due when it has an `unknownHolderSince` and was either never prompted or
   * was last prompted on a different calendar day — so the UI shows at most one
   * card per day for the whole batched set. Declined (terminal) peers are never
   * returned; `recordUnknownHolder` already refuses to queue them.
   */
  dueUnknownHolderPrompts(now: number): GrantRecord[] {
    const today = dayOf(now);
    return this.list().filter(
      (r) =>
        r.unknownHolderSince != null &&
        (r.lastPromptedAt == null || dayOf(r.lastPromptedAt) !== today),
    );
  }

  /**
   * "Not now" on the batched prompt card: stamps every currently-due
   * unknown-holder peer with `now` so the next `dueUnknownHolderPrompts` call
   * returns an empty set until the next calendar day. Persisted, so a reload
   * the same day does not re-surface the card. Does not grant, revoke, or
   * decline anything — the choice stays reversible on a future day.
   */
  async snoozeUnknownHolderPrompts(now: number): Promise<void> {
    const due = this.dueUnknownHolderPrompts(now);
    if (due.length === 0) return;
    for (const record of due) {
      this.records.set(record.peerId, { ...record, lastPromptedAt: now });
    }
    await this.opts.store.write([...this.records.values()]);
  }

  /** Volatile presence — updated in memory only, not persisted. */
  setPresence(peerId: string, presence: { online: boolean }): void {
    const existing = this.records.get(peerId);
    if (!existing) return;
    existing.online = presence.online;
    existing.lastSeenAt = presence.online ? this.now() : existing.lastSeenAt;
  }
}
