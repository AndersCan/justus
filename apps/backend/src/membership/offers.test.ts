import { describe, expect, test } from "vite-plus/test";
import { holdOffer, MAX_OFFERS_PER_SENDER, mayShowOfferFrom } from "./offers";

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

describe("holdOffer cap", () => {
  test("one sender cannot hold more than the cap; the oldest go first", () => {
    let held = [offer("other", b)];
    for (let i = 0; i < MAX_OFFERS_PER_SENDER + 5; i++) held = holdOffer(held, offer(`c${i}`, a));
    const fromA = held.filter((o) => o.owner === a);
    expect(fromA).toHaveLength(MAX_OFFERS_PER_SENDER);
    expect(fromA[0].code).toBe("c5");
    expect(fromA.at(-1)?.code).toBe(`c${MAX_OFFERS_PER_SENDER + 4}`);
    expect(held.filter((o) => o.owner === b)).toHaveLength(1);
  });

  test("replacing an existing invite at the cap drops nothing", () => {
    let held: ReturnType<typeof holdOffer> = [];
    for (let i = 0; i < MAX_OFFERS_PER_SENDER; i++) held = holdOffer(held, offer(`c${i}`, a));
    held = holdOffer(held, offer("c0", a, "Porto"));
    expect(held).toHaveLength(MAX_OFFERS_PER_SENDER);
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
