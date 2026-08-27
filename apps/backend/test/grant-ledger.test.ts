/**
 * Unit tests for the grant ledger (issue #30). Pure: no Bare runtime, backed by
 * an in-memory {@link LedgerStore}. Drives the reversible, observable operations
 * and the durability contract. The signed-receipt tests inject a Node ed25519
 * adapter (stand-in for the production bare-crypto one).
 */
import { GrantLedger, type GrantRecord, type LedgerStore } from "../src/grant-ledger.ts";
import { type InviteCrypto } from "../src/invite-receipt.ts";
import { describe, it, expect } from "vite-plus/test";
import { createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";

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

const DAY_MS = 24 * 60 * 60 * 1000;

/** Node ed25519 stand-in for the production bare-crypto adapter. */
function nodeInviteCrypto(): InviteCrypto {
  const { privateKey } = generateKeyPairSync("ed25519");
  const pubJwk = privateKey.export({ format: "jwk" }) as { x: string };
  const publicBytes = new Uint8Array(Buffer.from(pubJwk.x, "base64url"));
  const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return {
    publicKey: hex(publicBytes),
    sign: (msg) => new Uint8Array(sign(null, Buffer.from(msg), privateKey)),
    verify: (msg, sig, pk) => {
      const jwk = { kty: "OKP", crv: "Ed25519", x: Buffer.from(pk).toString("base64url") };
      return verify(
        null,
        Buffer.from(msg),
        createPublicKey({ key: jwk, format: "jwk" }),
        Buffer.from(sig),
      );
    },
  };
}

async function freshLedger(crypto?: InviteCrypto) {
  const { now, advance } = clock();
  const ledger = new GrantLedger({ store: new MemoryLedgerStore(), now, crypto });
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

  it("verifyReceipt auto-shares a valid receipt and records the verified inviter", async () => {
    const crypto = nodeInviteCrypto();
    const { ledger } = await freshLedger(crypto);
    await ledger.recordUnknownHolder("peer-b");
    const seen: string[] = [];
    ledger.on((e) => seen.push(e.type));
    const receipt = ledger.issueInvite({ inviteeId: "peer-b", albumId: "album-1" });
    const rec = await ledger.verifyReceipt("peer-b", { receipt });
    expect(rec.serveTo).toBe("granted");
    expect(rec.receipt).toBe(receipt);
    expect(rec.invitedBy).toBe(crypto.publicKey);
    expect(rec.unknownHolderSince).toBeUndefined();
    expect(seen).toEqual(["RECEIPT_VERIFIED", "GRANTED"]);
  });

  it("verifyReceipt treats an invalid receipt as an unknown holder, never a grant", async () => {
    const crypto = nodeInviteCrypto();
    const { ledger } = await freshLedger(crypto);
    await ledger.recordUnknownHolder("peer-b");
    const rec = await ledger.verifyReceipt("peer-b", { receipt: "not-a-receipt" });
    expect(rec.serveTo).toBe("undecided");
    expect(rec.unknownHolderSince).toBeGreaterThan(0);
    expect(rec.invitedBy).toBeUndefined();
  });

  it("verifyReceipt rejects a receipt addressed to a different peer", async () => {
    const crypto = nodeInviteCrypto();
    const { ledger } = await freshLedger(crypto);
    const receipt = ledger.issueInvite({ inviteeId: "peer-c", albumId: "album-1" });
    const rec = await ledger.verifyReceipt("peer-b", { receipt });
    expect(rec.serveTo).not.toBe("granted");
    expect(rec.invitedBy).toBeUndefined();
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

describe("unknown-holder prompt batching", () => {
  it("returns a queued unknown holder as due", async () => {
    const { ledger } = await freshLedger();
    await ledger.recordUnknownHolder("peer-x");
    const due = ledger.dueUnknownHolderPrompts(2_000);
    expect(due.map((r) => r.peerId)).toEqual(["peer-x"]);
  });

  it("never returns granted, revoked, or declined peers", async () => {
    const { ledger } = await freshLedger();
    await ledger.grant("peer-granted");
    await ledger.revoke("peer-revoked");
    await ledger.decline("peer-declined");
    await ledger.recordUnknownHolder("peer-granted");
    await ledger.recordUnknownHolder("peer-revoked");
    await ledger.recordUnknownHolder("peer-declined");
    expect(ledger.dueUnknownHolderPrompts(2_000)).toEqual([]);
  });

  it("snooze hides all due peers for the rest of the day, then re-shows next day", async () => {
    const { ledger, advance } = await freshLedger();
    await ledger.recordUnknownHolder("peer-x");
    await ledger.recordUnknownHolder("peer-y");
    // Same-day dismiss.
    await ledger.snoozeUnknownHolderPrompts(2_000);
    expect(ledger.dueUnknownHolderPrompts(3_000)).toEqual([]);
    // Next calendar day re-surface them.
    advance();
    expect(
      ledger
        .dueUnknownHolderPrompts(2_000 + DAY_MS)
        .map((r) => r.peerId)
        .sort(),
    ).toEqual(["peer-x", "peer-y"]);
  });

  it("snooze is persisted across reload", async () => {
    const store = new MemoryLedgerStore();
    const { now } = clock();
    const a = new GrantLedger({ store, now });
    await a.load();
    await a.recordUnknownHolder("peer-x");
    await a.snoozeUnknownHolderPrompts(now());

    const b = new GrantLedger({ store, now });
    await b.load();
    expect(b.dueUnknownHolderPrompts(now())).toEqual([]);
  });
});
