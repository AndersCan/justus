import { describe, expect, it } from "vite-plus/test";
import {
  dropOwed,
  holdOwed,
  liveOwed,
  MAX_OWED_PER_ALBUM,
  OFFER_HOLD_MS,
} from "../../src/membership/offers.ts";

describe("waiting friend invites", () => {
  it("holds an invite since now", () => {
    expect(holdOwed(undefined, "a", 5)).toEqual({ a: 5 });
  });

  it("holding again restarts the wait", () => {
    expect(holdOwed({ a: 1 }, "a", 9)).toEqual({ a: 9 });
  });

  it("past the cap the oldest goes", () => {
    const full = Object.fromEntries(
      Array.from({ length: MAX_OWED_PER_ALBUM }, (_, i) => [`k${i}`, i + 1]),
    );
    const next = holdOwed(full, "new", 100);
    expect(Object.keys(next)).toHaveLength(MAX_OWED_PER_ALBUM);
    expect(next.k0).toBeUndefined();
    expect(next.new).toBe(100);
  });

  it("expires exactly at 7 days", () => {
    const now = 10 * OFFER_HOLD_MS;
    expect(liveOwed({ a: now - OFFER_HOLD_MS }, now)).toEqual({});
    expect(liveOwed({ a: now - OFFER_HOLD_MS + 1 }, now)).toEqual({ a: now - OFFER_HOLD_MS + 1 });
    expect(liveOwed(undefined, now)).toEqual({});
  });

  it("drops a time far in the future (clock jump)", () => {
    expect(liveOwed({ a: 1 + OFFER_HOLD_MS + 1 }, 1)).toEqual({});
  });

  it("drops one identity, and nothing is left as undefined", () => {
    expect(dropOwed({ a: 1 }, "a")).toBeUndefined();
    expect(dropOwed({ a: 1, b: 2 }, "a")).toEqual({ b: 2 });
    expect(dropOwed(undefined, "a")).toBeUndefined();
  });
});
