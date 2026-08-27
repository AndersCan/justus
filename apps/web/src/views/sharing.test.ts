import { describe, it, expect } from "vite-plus/test";
import { inviteProvenance } from "./sharing";
import type { GrantRecord } from "@justus/core";

function record(over: Partial<GrantRecord> = {}): GrantRecord {
  return {
    peerId: "peer1234",
    serveTo: "granted",
    lastChangedAt: 0,
    ...over,
  };
}

describe("sharing invite provenance", () => {
  it("flags a peer that presented a verified signed invite", () => {
    expect(inviteProvenance(record({ receipt: "sig-payload" }))).toBe("verified invite");
  });

  it("shows nothing for a peer with no receipt", () => {
    expect(inviteProvenance(record())).toBeNull();
  });

  it("keeps the flag after sharing stopped", () => {
    expect(inviteProvenance(record({ serveTo: "revoked", receipt: "sig" }))).toBe(
      "verified invite",
    );
  });
});
