import { describe, expect, it } from "vite-plus/test";
import {
  MAX_EARLIER_ENTRIES,
  parseEarlier,
  parseFriendMessage,
} from "../../src/membership/records.ts";

const A = "a".repeat(64);
const B = "b".repeat(64);
const offer = { kind: "offer", code: A, albumName: "Trip", ownerName: "Anna" };

describe("parseFriendMessage move", () => {
  it("keeps a valid move", () => {
    const move = { from: [B], role: "member" };
    expect(parseFriendMessage({ ...offer, move })).toEqual({ ...offer, move });
  });
  it("parses an offer without move as before", () => {
    expect(parseFriendMessage(offer)).toEqual(offer);
  });
  it.each([
    ["bad role", { from: [B], role: "admin" }],
    ["empty from", { from: [], role: "reader" }],
    ["11 keys", { from: Array(11).fill(B), role: "reader" }],
    ["bad key", { from: ["xyz"], role: "reader" }],
    ["not an object", "member"],
    ["null", null],
  ])("drops the whole offer on %s", (_n, move) => {
    expect(parseFriendMessage({ ...offer, move })).toBeUndefined();
  });
});

describe("parseEarlier", () => {
  const file = (earlier: unknown, version: unknown = 1) => JSON.stringify({ version, earlier });
  it("reads entries with keptVersion", () => {
    expect(
      parseEarlier(
        file([
          { key: A, name: "Ben", keptVersion: 2 },
          { key: B, name: " " },
        ]),
      ),
    ).toEqual([
      { key: A, name: "Ben", keptVersion: 2 },
      { key: B, name: "Unknown device" },
    ]);
  });
  it("rejects bad keys, bad keptVersion and repeats", () => {
    expect(
      parseEarlier(
        file([
          { key: "nope", name: "x" },
          { key: A, name: "x", keptVersion: -1 },
          { key: A, name: "y" },
          5,
        ]),
      ),
    ).toEqual([{ key: A, name: "x" }]);
  });
  it("caps the list", () => {
    const many = Array.from({ length: MAX_EARLIER_ENTRIES + 5 }, (_, i) => ({
      key: i.toString(16).padStart(64, "0"),
      name: "n",
    }));
    expect(parseEarlier(file(many))).toHaveLength(MAX_EARLIER_ENTRIES);
  });
  it("unknown version is empty and reported", () => {
    let seen = 0;
    expect(parseEarlier(file([{ key: A, name: "x" }], 2), () => seen++)).toEqual([]);
    expect(seen).toBe(1);
  });
  it.each([null, "{", "null", "[]", file("x")])("never throws on %s", (text) => {
    expect(parseEarlier(text)).toEqual([]);
  });
});
