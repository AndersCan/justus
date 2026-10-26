import { describe, it, expect } from "vite-plus/test";
import { buildInvite } from "./invite";
import { qrPath } from "./qr";

describe("qrPath", () => {
  it("encodes an invite link into a square module grid", () => {
    const { size, d } = qrPath(buildInvite({ key: "ab".repeat(32), name: "Trip" }));
    expect(size).toBeGreaterThanOrEqual(21);
    expect(d.startsWith("M")).toBe(true);
  });
});
