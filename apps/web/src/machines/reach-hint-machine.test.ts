import { describe, expect, test, vi, beforeEach, afterEach } from "vite-plus/test";
import type { SyncStatus } from "@justus/core";
import { VirtualClock } from "@mantaq/core";
import {
  $reachHint,
  $reachState,
  createReachActor,
  reachHintOf,
  wireReachToSync,
} from "./reach-hint-machine";
import { createSyncActor, statusSeen, syncActor } from "./sync-machine";
import { REACH_HINT_AFTER_MS } from "../utils/reach-hint";

vi.mock("../gateway", () => ({
  gateway: { logs: { view: vi.fn(), clear: vi.fn() } },
}));

const setStatus = (status: SyncStatus) => syncActor.send(statusSeen.create({ status }));

const withPeers = (otherConnected: boolean) =>
  ({
    members: [
      { key: "me", name: "Nils", admin: false, connected: true },
      { key: "a", name: "Maya", admin: true, connected: otherConnected },
    ],
  }) as SyncStatus;

beforeEach(() => {
  vi.useFakeTimers();
  setStatus(withPeers(true));
});
afterEach(() => vi.useRealTimers());

describe("reach hint", () => {
  test("shows the hint only after about 30s of not reaching anyone", () => {
    setStatus(withPeers(false));
    expect($reachState.get()).toBe("trying");
    expect($reachHint.get()).toBeNull();
    vi.advanceTimersByTime(REACH_HINT_AFTER_MS - 1);
    expect($reachHint.get()).toBeNull();
    vi.advanceTimersByTime(2);
    expect($reachHint.get()).toMatch(/Can't reach Maya/);
  });

  test("reaching a member before the timeout cancels it", () => {
    setStatus(withPeers(false));
    vi.advanceTimersByTime(10_000);
    setStatus(withPeers(true));
    vi.advanceTimersByTime(REACH_HINT_AFTER_MS * 2);
    expect($reachState.get()).toBe("reachable");
    expect($reachHint.get()).toBeNull();
  });

  test("the hint clears once someone connects", () => {
    setStatus(withPeers(false));
    vi.advanceTimersByTime(REACH_HINT_AFTER_MS + 1);
    expect($reachHint.get()).not.toBeNull();
    setStatus(withPeers(true));
    expect($reachHint.get()).toBeNull();
  });
});

describe("reach actor on a virtual clock", () => {
  const unreachable = (name: string) => ({ type: "UNREACHABLE", payload: { name } }) as never;
  const reached = () => ({ type: "REACHED" }) as never;

  function setup() {
    const clock = VirtualClock();
    const actor = createReachActor({ clock });
    return { clock, actor };
  }

  test("the hint appears after the wait", async () => {
    const { clock, actor } = setup();
    actor.send(unreachable("Maya"));
    expect(actor.state.name).toBe("trying");
    clock.advance(REACH_HINT_AFTER_MS - 1);
    expect(actor.state.name).toBe("trying");
    clock.advance(1);
    await actor.settled();
    expect(actor.state.name).toBe("hint");
  });

  test("reaching someone cancels the wait", async () => {
    const { clock, actor } = setup();
    actor.send(unreachable("Maya"));
    clock.advance(10_000);
    actor.send(reached());
    clock.advance(REACH_HINT_AFTER_MS * 2);
    await actor.settled();
    expect(actor.state.name).toBe("reachable");
  });

  test("reaching someone clears the hint", async () => {
    const { clock, actor } = setup();
    actor.send(unreachable("Maya"));
    clock.advance(REACH_HINT_AFTER_MS);
    await actor.settled();
    actor.send(reached());
    expect(actor.state.name).toBe("reachable");
  });

  test("the name updates while trying and in the hint", async () => {
    const { clock, actor } = setup();
    actor.send(unreachable("Maya"));
    actor.send(unreachable("Noor"));
    expect(actor.snapshot().context.name).toBe("Noor");
    clock.advance(REACH_HINT_AFTER_MS);
    await actor.settled();
    actor.send(unreachable("Ola"));
    expect(actor.state.name).toBe("hint");
    expect(actor.snapshot().context.name).toBe("Ola");
  });
});

describe("wireReachToSync", () => {
  function wired(status: () => Promise<[unknown, unknown]>) {
    const clock = VirtualClock();
    const sync = createSyncActor({ clock, gateway: { status } as never });
    const reach = createReachActor({ clock });
    sync.send(statusSeen.create({ status: withPeers(false) }));
    wireReachToSync(reach, sync);
    return { clock, sync, reach };
  }

  test("acts once on the current status when wired", () => {
    const { reach } = wired(async () => [null, null]);
    expect(reach.state.name).toBe("trying");
    expect(reachHintOf(reach.snapshot())).toBeNull();
  });

  test("an unrelated sync change with the same status keeps the wait running", async () => {
    const { clock, sync, reach } = wired(async () => [new Error("offline"), null]);
    clock.advance(20_000);
    sync.send({ type: "REFRESH" } as never);
    await sync.settled();
    expect(sync.snapshot().context.error).toBe("offline");
    clock.advance(10_000);
    await reach.settled();
    expect(reach.state.name).toBe("hint");
    expect(reachHintOf(reach.snapshot())).toMatch(/Can't reach Maya/);
  });

  test("a new status object is acted on", () => {
    const { sync, reach } = wired(async () => [null, null]);
    sync.send(statusSeen.create({ status: withPeers(true) }));
    expect(reach.state.name).toBe("reachable");
  });
});
