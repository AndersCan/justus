import { describe, expect, test } from "vite-plus/test";
import { holdOffer, mayShowOfferFrom } from "./offers";

const a = "a".repeat(64);
const b = "b".repeat(64);
const offer = (code: string, owner: string, albumName = "Lisbon") => ({
  code,
  owner,
  albumName,
  ownerName: "Nils",
});

describe("holdOffer", () => {
  test("adds an invite", () => {
    expect(holdOffer([], offer("c1", a))).toEqual([offer("c1", a)]);
  });

  test("the same code and Admin replaces the old invite", () => {
    const held = holdOffer([offer("c1", a)], offer("c1", a, "Porto"));
    expect(held).toEqual([offer("c1", a, "Porto")]);
  });

  test("the same code from another Admin, or another code, is kept", () => {
    expect(holdOffer([offer("c1", a)], offer("c1", b))).toHaveLength(2);
    expect(holdOffer([offer("c1", a)], offer("c2", a))).toHaveLength(2);
  });
});

describe("mayShowOfferFrom", () => {
  const none = { isFriend: false, coMembers: new Set<string>(), albumAdmins: new Set<string>() };

  test("a stranger is turned away", () => {
    expect(mayShowOfferFrom(a, none)).toBe(false);
  });

  test("a friend, a co-member or an Admin of one of our albums may send one", () => {
    expect(mayShowOfferFrom(a, { ...none, isFriend: true })).toBe(true);
    expect(mayShowOfferFrom(a, { ...none, coMembers: new Set([a]) })).toBe(true);
    expect(mayShowOfferFrom(a, { ...none, albumAdmins: new Set([a]) })).toBe(true);
    expect(mayShowOfferFrom(a, { ...none, albumAdmins: new Set([b]) })).toBe(false);
  });
});
