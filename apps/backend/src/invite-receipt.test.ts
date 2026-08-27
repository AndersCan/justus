/**
 * Unit tests for the signed invite-receipt primitive (issue #30 signed-receipts).
 * Pure: a Node ed25519 adapter stands in for the production bare-crypto one, so
 * the trust boundary is exercised without a Bare runtime.
 */
import { describe, it, expect } from "vite-plus/test";
import {
  issueInvite,
  verifyInvite,
  hexEncode,
  hexDecode,
  type InviteCrypto,
} from "./invite-receipt";
import { createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";

/** Node ed25519 stand-in for the production bare-crypto adapter. */
function nodeInviteCrypto(): InviteCrypto {
  const { privateKey } = generateKeyPairSync("ed25519");
  const pubJwk = privateKey.export({ format: "jwk" }) as { x: string };
  const publicBytes = new Uint8Array(Buffer.from(pubJwk.x, "base64url"));
  return {
    publicKey: hexEncode(publicBytes),
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

describe("invite-receipt", () => {
  it("round-trips: a signed receipt verifies for the intended invitee", () => {
    const crypto = nodeInviteCrypto();
    const receipt = issueInvite(crypto, { inviteeId: "peer-b", albumId: "album-1" });
    const result = verifyInvite(crypto, receipt, "peer-b");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.inviterId).toBe(crypto.publicKey);
  });

  it("rejects a receipt addressed to a different invitee", () => {
    const crypto = nodeInviteCrypto();
    const receipt = issueInvite(crypto, { inviteeId: "peer-b", albumId: "album-1" });
    expect(verifyInvite(crypto, receipt, "peer-c").ok).toBe(false);
  });

  it("rejects a tampered signature", () => {
    const crypto = nodeInviteCrypto();
    const receipt = JSON.parse(issueInvite(crypto, { inviteeId: "peer-b", albumId: "album-1" }));
    receipt.sig = hexEncode(new Uint8Array(64).fill(9));
    expect(verifyInvite(crypto, JSON.stringify(receipt), "peer-b").ok).toBe(false);
  });

  it("rejects a receipt whose inviter id was swapped after signing", () => {
    const crypto = nodeInviteCrypto();
    const receipt = JSON.parse(issueInvite(crypto, { inviteeId: "peer-b", albumId: "album-1" }));
    receipt.inviterId = hexEncode(new Uint8Array(32).fill(1));
    expect(verifyInvite(crypto, JSON.stringify(receipt), "peer-b").ok).toBe(false);
  });

  it("rejects malformed JSON", () => {
    const crypto = nodeInviteCrypto();
    expect(verifyInvite(crypto, "not json", "peer-b").ok).toBe(false);
  });

  it("hex encode/decode is lossless", () => {
    const bytes = new Uint8Array([0, 1, 15, 16, 255, 128]);
    expect(hexDecode(hexEncode(bytes))).toEqual(bytes);
  });
});
