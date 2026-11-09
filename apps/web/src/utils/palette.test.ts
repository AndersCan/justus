import { describe, expect, it } from "vite-plus/test";
import { memberColor } from "./palette";

const SEATS = [0, 1, 2, 3, 4].map((seat) => memberColor(seat) ?? "");
// Light and dark values of --trust-green, --trust-amber and --trust-red in tokens.css.
const STATUS = ["#0E8F82", "#2EC4B2", "#F5A623", "#E5484D", "#FF6B72"];

function rgb(hex: string): number[] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function distance(a: string, b: string): number {
  const [ar, ag, ab] = rgb(a);
  const [br, bg, bb] = rgb(b);
  return Math.hypot(ar! - br!, ag! - bg!, ab! - bb!);
}

describe("memberColor", () => {
  it("gives seat 0 pink and seat 1 teal", () => {
    expect(memberColor(0)).toBe("#C2457A");
    expect(memberColor(1)).toBe("#155E75");
  });
  it("gives seat 3 brown", () => {
    expect(memberColor(3)).toBe("#8A5232");
  });
  it("repeats from the sixth seat", () => {
    expect(memberColor(5)).toBe(memberColor(0));
  });
  it("gives no colour without a seat", () => {
    expect(memberColor(undefined)).toBeUndefined();
  });
  it("keeps white badge text readable on every seat colour", () => {
    for (const seat of SEATS) expect(1.05 / (luminance(seat) + 0.05)).toBeGreaterThanOrEqual(4.5);
  });
  it("never uses a connection-status colour for a person", () => {
    for (const seat of SEATS)
      for (const status of STATUS) expect(distance(seat, status)).toBeGreaterThan(40);
  });
});
