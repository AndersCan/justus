/**
 * Unit tests for the grant ledger (issue #30, first slice). Pure: no Bare
 * runtime, backed by an in-memory {@link LedgerStore}. Drives the reversible,
 * observable operations and the durability contract.
 */
import { GrantLedger, type GrantRecord, type LedgerStore } from "../src/grant-ledger.ts";
import { describe, it, expect } from "vite-plus/test";

class MemoryLedgerStore implements LedgerStore {
  private data: GrantRecord[] = [];
  async read(): Promise<GrantRecord[]> {
    return this.data.map((r) => ({ ...r }));
  }
  async write(records: GrantRecord[]): Promise<void> {
    this.data = records.map((r) => ({ ...r }));
  }
}

/** Deterministic clock so emitted timestamps are assertable. */
function clock(): { now: () => number; advance: () => void } {
  let time = 1_000;
  return { now: () => time, advance: () => (time += 1) };
}

async function freshLedger() {
  const { now, advance } = clock();
  const ledger = new GrantLedger({ store: new MemoryLedgerStore(), now });
  await ledger.load();
  return { ledger, advance };
}

describe("grant-ledger", () => {
  it("starts every peer as undecided", async () => {
    const { ledger } = await freshLedger();
    const state = ledger.getState("peer-a");
    expect(state.serveTo).toBe("undecided");
    expect(ledger.list()).toEqual([]);
  });

  it("grant marks the peer granted and emits GRANTED", async () => {
    const { ledger } = await freshLedger();
    const seen: string[] = [];
    ledger.on((e) => seen.push(e.type));
    const rec = await ledger.grant("peer-a");
    expect(rec.serveTo).toBe("granted");
    expect(rec.declinedTerminal).toBe(false);
    expect(seen).toEqual(["GRANTED"]);
  });

  it("revoke is reversible and never deletes the record", async () => {
    const { ledger } = await freshLedger();
    await ledger.grant("peer-a");
    const revoked = await ledger.revoke("peer-a");
    expect(revoked.serveTo).toBe("revoked");
    // The record still exists — the peer keeps what they already have.
    const after = ledger.getState("peer-a");
    expect(after.peerId).toBe("peer-a");
    expect(after.receipt).toBeUndefined();
    // Re-granting is a normal, observable transition.
    const reGranted = await ledger.grant("peer-a");
    expect(reGranted.serveTo).toBe("granted");
  });

  it("decline is terminal: an unknown-holder prompt never re-queues it", async () => {
    const { ledger } = await freshLedger();
    await ledger.decline("peer-a");
    const events: string[] = [];
    ledger.on((e) => events.push(e.type));
    const rec = await ledger.recordUnknownHolder("peer-a");
    expect(rec.declinedTerminal).toBe(true);
    expect(rec.unknownHolderSince).toBeUndefined();
    expect(events).toEqual([]);
  });

  it("verifyReceipt auto-shares and clears any unknown-holder state", async () => {
    const { ledger } = await freshLedger();
    await ledger.recordUnknownHolder("peer-b");
    const seen: string[] = [];
    ledger.on((e) => seen.push(e.type));
    const rec = await ledger.verifyReceipt("peer-b", {
      receipt: "receipt-payload",
    });
    expect(rec.serveTo).toBe("granted");
    expect(rec.receipt).toBe("receipt-payload");
    expect(rec.unknownHolderSince).toBeUndefined();
    expect(seen).toEqual(["RECEIPT_VERIFIED", "GRANTED"]);
  });

  it("recordUnknownHolder queues once per peer and only for unknown peers", async () => {
    const { ledger } = await freshLedger();
    // Known (granted) peer is not an unknown holder.
    await ledger.grant("peer-known");
    const known = await ledger.recordUnknownHolder("peer-known");
    expect(known.unknownHolderSince).toBeUndefined();

    // Unknown peer is queued exactly once.
    const first = await ledger.recordUnknownHolder("peer-c");
    expect(first.unknownHolderSince).toBeGreaterThan(0);
    const second = await ledger.recordUnknownHolder("peer-c");
    expect(second).toBe(first);
  });

  it("persists every mutation and reloads it", async () => {
    const store = new MemoryLedgerStore();
    const { now } = clock();
    const a = new GrantLedger({ store, now });
    await a.load();
    await a.grant("peer-a");
    await a.revoke("peer-b");

    const b = new GrantLedger({ store, now });
    await b.load();
    expect(b.getState("peer-a").serveTo).toBe("granted");
    expect(b.getState("peer-b").serveTo).toBe("revoked");
    expect(b.list()).toHaveLength(2);
  });

  it("resets volatile presence on load", async () => {
    const store = new MemoryLedgerStore();
    const { now } = clock();
    const a = new GrantLedger({ store, now });
    await a.load();
    await a.grant("peer-a");
    a.setPresence("peer-a", { online: true });
    expect(a.getState("peer-a").online).toBe(true);

    const b = new GrantLedger({ store, now });
    await b.load();
    expect(b.getState("peer-a").online).toBeUndefined();
  });

  it("unsubscribes a listener", async () => {
    const { ledger } = await freshLedger();
    const seen: string[] = [];
    const off = ledger.on((e) => seen.push(e.type));
    off();
    await ledger.grant("peer-a");
    expect(seen).toEqual([]);
  });
});
