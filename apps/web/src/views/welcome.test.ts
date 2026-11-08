import { describe, it, expect, vi, afterEach } from "vite-plus/test";

vi.mock("./toast", () => ({ toast: vi.fn() }));
vi.mock("../gateway", () => ({ gateway: { lock: { status: vi.fn(), setEnabled: vi.fn() } } }));

import { onboardingActor } from "../machines/onboarding-machine";
import { hasSeenWelcome, markWelcomeSeen, readLockForOnboarding } from "./welcome";

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

describe("readLockForOnboarding", () => {
  const ok = <T>(v: T) => Promise.resolve([null, v] as [null, T]);
  const lock = () => onboardingActor.snapshot().context.lock;

  it("never asks the phone outside the shell", async () => {
    vi.stubGlobal("window", {});
    const load = vi.fn();
    await readLockForOnboarding(load);
    expect(load).not.toHaveBeenCalled();
    expect(lock()).toBeUndefined();
  });

  it("hands a valid status to onboarding", async () => {
    vi.stubGlobal("window", { BareShell: true });
    await readLockForOnboarding(() => ok({ available: true, enabled: false }));
    expect(lock()).toEqual({ available: true, enabled: false });
  });

  it("leaves onboarding unchanged on an error or a malformed status", async () => {
    vi.stubGlobal("window", { BareShell: true });
    await readLockForOnboarding(() => Promise.resolve([new Error("x"), null]) as never);
    await readLockForOnboarding(() => ok({ available: "yes" }) as never);
    expect(lock()).toEqual({ available: true, enabled: false });
  });
});
