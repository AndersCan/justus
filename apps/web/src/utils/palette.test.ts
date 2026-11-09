import { describe, expect, it } from "vite-plus/test";
import { memberColor } from "./palette";

describe("memberColor", () => {
  it("gives seat 0 pink and seat 1 green", () => {
    expect(memberColor(0)).toBe("#C2457A");
    expect(memberColor(1)).toBe("#3A8A4C");
  });
  it("repeats from the sixth seat", () => {
    expect(memberColor(5)).toBe(memberColor(0));
  });
  it("gives no colour without a seat", () => {
    expect(memberColor(undefined)).toBeUndefined();
  });
});
