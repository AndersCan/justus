import { describe, expect, it } from "vite-plus/test";
import { memberColor } from "./palette";

const SEATS = [0, 1, 2, 3, 4].map((seat) => memberColor(seat) ?? "");
// Light and dark --trust-*, --ok(-fg), --warn(-fg) and --danger(-fg) in design/justus/tokens/theme.css.
const STATUS = [
  "#10B981",
  "#059669",
  "#047857",
  "#FBBF24",
  "#92400E",
  "#EF4444",
  "#DC2626",
  "#B91C1C",
  "#34D399",
  "#F87171",
];
// Light --accent and --accent-strong (indigo).
const ACCENT = ["#4F46E5", "#4338CA"];
const DARK_SURFACE = "#0F172A";

function rgb(hex: string): number[] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

function linear(hex: string): number[] {
  return rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
}

function luminance(hex: string): number {
  const [r, g, b] = linear(hex);
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function hue(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => v / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d === 0) return 0;
  const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return h * 60;
}

function lab(hex: string): number[] {
  const [r, g, b] = linear(hex);
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = f((0.4124 * r! + 0.3576 * g! + 0.1805 * b!) / 0.95047);
  const y = f(0.2126 * r! + 0.7152 * g! + 0.0722 * b!);
  const z = f((0.0193 * r! + 0.1192 * g! + 0.9505 * b!) / 1.089);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

/** CIE76 colour difference: about 2.3 is just noticeable, 20 is clearly another colour. */
function distance(a: string, b: string): number {
  const [al, aa, ab] = lab(a);
  const [bl, ba, bb] = lab(b);
  return Math.hypot(al! - bl!, aa! - ba!, ab! - bb!);
}

describe("memberColor", () => {
  it("gives seat 0 magenta and seat 1 blue", () => {
    expect(memberColor(0)).toBe("#B0408C");
    expect(memberColor(1)).toBe("#2672C0");
  });
  it("gives seat 2 violet", () => {
    expect(memberColor(2)).toBe("#9A3AF0");
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
      for (const status of STATUS) expect(distance(seat, status)).toBeGreaterThan(20);
  });
  it("keeps every seat 30 degrees of hue from every status colour", () => {
    for (const seat of SEATS)
      for (const status of STATUS) {
        const gap = Math.abs(hue(seat) - hue(status));
        expect(Math.min(gap, 360 - gap)).toBeGreaterThanOrEqual(30);
      }
  });
  it("keeps every seat clear of the brand indigo", () => {
    for (const seat of SEATS)
      for (const accent of ACCENT) expect(distance(seat, accent)).toBeGreaterThan(20);
  });
  it("tells every pair of seats apart", () => {
    for (const [i, a] of SEATS.entries())
      for (const b of SEATS.slice(i + 1)) expect(distance(a, b)).toBeGreaterThan(30);
  });
  it("stays visible on the dark surface", () => {
    for (const seat of SEATS)
      expect((luminance(seat) + 0.05) / (luminance(DARK_SURFACE) + 0.05)).toBeGreaterThanOrEqual(3);
  });
});
