import { createHash } from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import { checkCode } from "./check-code";
import { WORDS } from "./words";

const crypto = { createHash } as unknown as Parameters<typeof checkCode>[1];
const key = "ab".repeat(32);

describe("checkCode", () => {
  it("is three lowercase words", () => {
    expect(checkCode(key, crypto)).toMatch(/^[a-z]+ [a-z]+ [a-z]+$/);
  });

  it("uses a 2048-word list of unique words", () => {
    expect(WORDS).toHaveLength(2048);
    expect(new Set(WORDS).size).toBe(2048);
  });

  it("matches the hand-computed sha256 value", () => {
    const hash = createHash("sha256").update(`justus-check:${key}`).digest();
    const expected = [0, 2, 4].map((o) => WORDS[hash.readUInt16BE(o) & 2047]).join(" ");
    expect(checkCode(key, crypto)).toBe(expected);
  });

  it("is deterministic and ignores hex case", () => {
    const hex = "abcdef".repeat(10) + "abcd";
    expect(checkCode(hex, crypto)).toBe(checkCode(hex, crypto));
    expect(checkCode(hex.toUpperCase(), crypto)).toBe(checkCode(hex, crypto));
  });

  it("differs between keys", () => {
    expect(checkCode("cd".repeat(32), crypto)).not.toBe(checkCode(key, crypto));
  });
});
