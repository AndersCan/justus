import { describe, it, expect } from "vite-plus/test";
import { buildInviteLink } from "./invite-link";
import { qrPath } from "./qr";

describe("qrPath", () => {
  it("encodes an invite link into a square module grid", () => {
    const { size, d } = qrPath(
      buildInviteLink({
        code: "ab".repeat(32),
        owner: "cd".repeat(32),
        album: "Trip",
        ownerName: "Nils",
      }),
    );
    expect(size).toBeGreaterThanOrEqual(21);
    expect(d.startsWith("M")).toBe(true);
  });
});
