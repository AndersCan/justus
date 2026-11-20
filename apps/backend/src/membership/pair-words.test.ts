import { createHash } from "node:crypto";
import { describe, expect, test } from "vite-plus/test";
import { pairWords } from "./pair-words";
import { WORDS } from "./words";

const crypto = { createHash } as unknown as Parameters<typeof pairWords>[2];
const A = "ab".repeat(32);
const B = "cd".repeat(32);
const C = "ef".repeat(32);

describe("pairWords", () => {
  test("four lowercase words", () => {
    expect(pairWords(A, B, crypto)).toMatch(/^[a-z]+( [a-z]+){3}$/);
  });

  test("same words on both phones, whatever the case", () => {
    expect(pairWords(A, B, crypto)).toBe(pairWords(B, A, crypto));
    expect(pairWords(A.toUpperCase(), B, crypto)).toBe(pairWords(A, B, crypto));
  });

  test("fixed vectors", () => {
    expect(pairWords(A, B, crypto)).toBe("early steel produce clap");
    expect(pairWords(A, C, crypto)).toBe("zebra dizzy seat example");
    expect(pairWords(B, C, crypto)).toBe("unable doll robust still");
  });

  test("matches sha-256 of the prefixed sorted keys at offsets 0, 2, 4, 6", () => {
    const hash = crypto.createHash("sha-256").update(`justus-pair:${A}:${B}`).digest();
    const bytes = Buffer.from(hash);
    const expected = [0, 2, 4, 6].map((o) => WORDS[bytes.readUInt16BE(o) & 2047]).join(" ");
    expect(pairWords(B, A, crypto)).toBe(expected);
  });
});
