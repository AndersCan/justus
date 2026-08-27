/**
 * Signed invite receipts — the cryptographic trust primitive behind issue #30's
 * "invitation is a signed receipt that is also the auto-share grant".
 *
 * An invite receipt is a compact, self-describing token: it carries the
 * inviter's public key (their peer id), the invitee it is meant for, the album
 * being shared, and an ed25519 signature over those three fields. The invitee
 * verifies the signature against the inviter's public key carried in the
 * receipt; a valid receipt auto-shares the inviter's album, while a missing or
 * invalid receipt falls back to the unknown-holder prompt (never a silent
 * grant).
 *
 * The module is deliberately pure: it imports neither Bare nor Node crypto. The
 * signing/verification primitives are injected via {@link InviteCrypto}, so the
 * logic is unit-testable under plain Node (see invite-receipt.test.ts) and the
 * production adapter (bare-crypto ed25519) is supplied by the caller. This keeps
 * the trust boundary in one auditable place.
 */

/** A signed invite, serialised as JSON for transport over the framed socket. */
export interface InviteReceipt {
  /** Inviter's public key as hex — also their peer id. */
  inviterId: string;
  /** Invitee's public key as hex — the receipt only verifies for this peer. */
  inviteeId: string;
  /** Album/folder key being shared. */
  albumId: string;
  /** ed25519 signature over the canonical payload, hex-encoded. */
  sig: string;
}

/**
 * The crypto surface the receipt logic needs. Injected so the module stays
 * pure and testable. `publicKey` is this device's own public key (hex), used as
 * the inviter id when issuing; `verify` reconstructs the inviter's public key
 * from the receipt's `inviterId` bytes.
 */
export interface InviteCrypto {
  publicKey: string;
  sign(msg: Uint8Array): Uint8Array;
  verify(msg: Uint8Array, sig: Uint8Array, publicKey: Uint8Array): boolean;
}

export function hexEncode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

export function hexDecode(hex: string): Uint8Array {
  const clean = hex.length % 2 === 0 ? hex : hex.slice(0, hex.length - 1);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Canonical, unambiguous payload that gets signed. */
function canonical(r: { inviterId: string; inviteeId: string; albumId: string }): Uint8Array {
  const payload = JSON.stringify({
    inviterId: r.inviterId,
    inviteeId: r.inviteeId,
    albumId: r.albumId,
  });
  return new TextEncoder().encode(payload);
}

/**
 * Issue a signed invite receipt for `inviteeId` to share `albumId`. The returned
 * string is JSON and is what gets handed to the invitee (and later submitted to
 * `GrantLedger.verifyReceipt`).
 */
export function issueInvite(
  crypto: InviteCrypto,
  args: { inviteeId: string; albumId: string },
): string {
  const receipt: InviteReceipt = {
    inviterId: crypto.publicKey,
    inviteeId: args.inviteeId,
    albumId: args.albumId,
    sig: hexEncode(
      crypto.sign(
        canonical({
          inviterId: crypto.publicKey,
          inviteeId: args.inviteeId,
          albumId: args.albumId,
        }),
      ),
    ),
  };
  return JSON.stringify(receipt);
}

/**
 * Verify a receipt JSON string for `expectedInviteeId`. Returns the verified
 * inviter id on success, or `{ ok: false }` when the receipt is malformed, not
 * meant for this peer, or the signature does not check out. A `false` result is
 * the signal to treat the peer as an unknown holder, never to grant.
 */
export function verifyInvite(
  crypto: InviteCrypto,
  receiptJson: string,
  expectedInviteeId: string,
): { ok: true; inviterId: string } | { ok: false } {
  let receipt: InviteReceipt;
  try {
    receipt = JSON.parse(receiptJson) as InviteReceipt;
  } catch {
    return { ok: false };
  }
  if (!receipt || typeof receipt !== "object") return { ok: false };
  if (typeof receipt.inviterId !== "string" || typeof receipt.inviteeId !== "string") {
    return { ok: false };
  }
  if (receipt.inviteeId !== expectedInviteeId) return { ok: false };

  const msg = canonical(receipt);
  const sig = hexDecode(receipt.sig);
  const publicKey = hexDecode(receipt.inviterId);
  const ok = crypto.verify(msg, sig, publicKey);
  return ok ? { ok: true, inviterId: receipt.inviterId } : { ok: false };
}
