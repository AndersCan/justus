import { describe, it, expect } from "vite-plus/test";
import { buildInvite, parseInvite } from "./invite";

const KEY = "ab".repeat(32);

describe("invite", () => {
  it("round-trips a link with hints", () => {
    const link = buildInvite({ key: KEY, name: "Spain 2026 & friends", admin: "Maya", members: 3 });
    expect(link.startsWith(`justus://join/${KEY}?`)).toBe(true);
    expect(parseInvite(link)).toEqual({
      key: KEY,
      name: "Spain 2026 & friends",
      admin: "Maya",
      members: 3,
    });
  });

  it("builds a bare link when there are no hints", () => {
    expect(buildInvite({ key: KEY.toUpperCase() })).toBe(`justus://join/${KEY}`);
  });

  it("finds a link inside a shared message", () => {
    expect(parseInvite(`Join my album: justus://join/${KEY}?n=Trip and enjoy`)?.name).toBe("Trip");
  });

  it("accepts a bare key, with spacing and any case", () => {
    const grouped = KEY.toUpperCase().replace(/(.{8})/g, "$1 ");
    expect(parseInvite(grouped)).toEqual({ key: KEY });
  });

  it("rejects text without a key", () => {
    expect(parseInvite("hello")).toBeNull();
    expect(parseInvite(`justus://join/${KEY.slice(1)}`)).toBeNull();
  });

  it("ignores a malformed member count", () => {
    expect(parseInvite(`justus://join/${KEY}?m=abc`)?.members).toBeUndefined();
    expect(parseInvite(`justus://join/${KEY}?m=-2`)?.members).toBeUndefined();
  });
});
