import { describe, expect, test, vi, beforeEach, afterEach } from "vite-plus/test";
import type { SyncStatus } from "@justus/core";
import { $reachHint, $reachState } from "./reach-hint-machine";
import { $syncStatus } from "./sync-machine";
import { REACH_HINT_AFTER_MS } from "../utils/reach-hint";

vi.mock("../gateway", () => ({
  gateway: { logs: { view: vi.fn(), clear: vi.fn() } },
}));

const withPeers = (otherConnected: boolean) =>
  ({
    members: [
      { key: "me", name: "Nils", admin: false, connected: true },
      { key: "a", name: "Maya", admin: true, connected: otherConnected },
    ],
  }) as SyncStatus;

beforeEach(() => {
  vi.useFakeTimers();
  $syncStatus.set(withPeers(true));
});
afterEach(() => vi.useRealTimers());

describe("reach hint", () => {
  test("shows the hint only after about 30s of not reaching anyone", () => {
    $syncStatus.set(withPeers(false));
    expect($reachState.get()).toBe("trying");
    expect($reachHint.get()).toBeNull();
    vi.advanceTimersByTime(REACH_HINT_AFTER_MS - 1);
    expect($reachHint.get()).toBeNull();
    vi.advanceTimersByTime(2);
    expect($reachHint.get()).toMatch(/Can't reach Maya/);
  });

  test("reaching a member before the timeout cancels it", () => {
    $syncStatus.set(withPeers(false));
    vi.advanceTimersByTime(10_000);
    $syncStatus.set(withPeers(true));
    vi.advanceTimersByTime(REACH_HINT_AFTER_MS * 2);
    expect($reachState.get()).toBe("reachable");
    expect($reachHint.get()).toBeNull();
  });

  test("the hint clears once someone connects", () => {
    $syncStatus.set(withPeers(false));
    vi.advanceTimersByTime(REACH_HINT_AFTER_MS + 1);
    expect($reachHint.get()).not.toBeNull();
    $syncStatus.set(withPeers(true));
    expect($reachHint.get()).toBeNull();
  });
});
