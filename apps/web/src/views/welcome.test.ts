import { describe, it, expect, vi, afterEach } from "vite-plus/test";
import { hasSeenWelcome, markWelcomeSeen } from "./welcome";

function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    getItem: (k: string) => (map.has(k) ? (map.get(k) ?? null) : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  } satisfies Storage;
}

afterEach(() => vi.unstubAllGlobals());

describe("welcome seen flag", () => {
  it("returns false before the welcome flag is set", () => {
    vi.stubGlobal("localStorage", fakeStorage());
    expect(hasSeenWelcome()).toBe(false);
  });

  it("returns true after the welcome flag is set", () => {
    vi.stubGlobal("localStorage", fakeStorage());
    markWelcomeSeen();
    expect(hasSeenWelcome()).toBe(true);
  });

  it("returns true when localStorage is unavailable", () => {
    // No localStorage global in this environment — the non-browser branch must
    // still resolve to "seen" rather than throwing or looping on welcome.
    expect(hasSeenWelcome()).toBe(true);
  });
});
