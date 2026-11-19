import { expect, test } from "vite-plus/test";
import { presenceOf } from "./presence";

function clockAt(now: number) {
  return { now };
}

test("a connected member is connected at any time", () => {
  expect(presenceOf({ connected: true }, clockAt(0))).toBe("connected");
  expect(presenceOf({ connected: true, lastSeenAt: 1 }, clockAt(9_999_999))).toBe("connected");
});

test("a gap under 30 s still reads as connected, 30 s reads as off", () => {
  const gone = { connected: false, lastSeenAt: 100_000 };
  expect(presenceOf(gone, clockAt(100_000))).toBe("connected");
  expect(presenceOf(gone, clockAt(129_999))).toBe("connected");
  expect(presenceOf(gone, clockAt(130_000))).toBe("off");
  expect(presenceOf(gone, clockAt(100_000 + 3 * 86_400_000))).toBe("off");
});

test("a last seen in the future (clock moved back) reads as off", () => {
  expect(presenceOf({ connected: false, lastSeenAt: 200_000 }, clockAt(150_000))).toBe("off");
});

test("a member never seen is neverConnected, at any time", () => {
  expect(presenceOf({ connected: false }, clockAt(10_000))).toBe("neverConnected");
  expect(presenceOf({ connected: false }, clockAt(30_000))).toBe("neverConnected");
});
