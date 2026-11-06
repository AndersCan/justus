import { createHash } from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import { inviteTopic } from "./invite";

const crypto = { createHash } as unknown as Parameters<typeof inviteTopic>[1];
const code = "ab".repeat(32);

describe("inviteTopic", () => {
  it("is the sha256 of the prefixed code, 32 bytes", () => {
    const topic = inviteTopic(code, crypto);
    expect(topic.length).toBe(32);
    expect(topic.toString("hex")).toBe(
      createHash("sha256").update(`justus-invite:${code}`).digest("hex"),
    );
  });

  it("differs per code and from the code itself", () => {
    const other = inviteTopic("cd".repeat(32), crypto);
    expect(other.equals(inviteTopic(code, crypto))).toBe(false);
    expect(inviteTopic(code, crypto).toString("hex")).not.toBe(code);
  });
});
