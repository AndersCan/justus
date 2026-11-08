import { createHash } from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import { checkCode } from "./check-code";

const crypto = { createHash } as unknown as Parameters<typeof checkCode>[1];
const key = "ab".repeat(32);

describe("checkCode", () => {
  it("is two groups of four digits", () => {
    expect(checkCode(key, crypto)).toMatch(/^\d{4} \d{4}$/);
  });

  it("matches the hand-computed sha256 value", () => {
    const hash = createHash("sha256").update(`justus-check:${key}`).digest();
    const digits = String(hash.readUInt32BE(0) % 100_000_000).padStart(8, "0");
    expect(checkCode(key, crypto)).toBe(`${digits.slice(0, 4)} ${digits.slice(4)}`);
  });

  it("is deterministic and ignores hex case", () => {
    const hex = "abcdef".repeat(10) + "abcd";
    expect(checkCode(hex, crypto)).toBe(checkCode(hex, crypto));
    expect(checkCode(hex.toUpperCase(), crypto)).toBe(checkCode(hex, crypto));
  });

  it("differs between keys", () => {
    expect(checkCode("cd".repeat(32), crypto)).not.toBe(checkCode(key, crypto));
  });

  it("keeps leading zeros", () => {
    for (let i = 0; i < 5000; i++) {
      const id = i.toString(16).padStart(64, "0");
      const code = checkCode(id, crypto);
      if (code.startsWith("0")) {
        expect(code).toMatch(/^0\d{3} \d{4}$/);
        return;
      }
    }
    throw new Error("no leading-zero code found");
  });
});
