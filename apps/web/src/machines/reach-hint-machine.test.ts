import { describe, expect, test, vi, beforeEach, afterEach } from "vite-plus/test";
import type { SyncStatus } from "@justus/core";
import { VirtualClock } from "@mantaq/core";
import {
  connectionGivenUp,
  createReachActor,
  reachActor,
  reachHintOf,
  wireReachToSync,
} from "./reach-hint-machine";
import { createSyncActor, statusSeen, syncActor } from "./sync-machine";
import { CONNECTING_FOR_MS, REACH_HINT_AFTER_MS } from "../utils/reach-hint";

vi.mock("../gateway", () => ({
  gateway: { logs: { view: vi.fn(), clear: vi.fn() } },
}));

const hintNow = () => reachHintOf(reachActor.snapshot());
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
    expect(reachActor.snapshot().path[0]).toBe("tryingToReachMembers");
    expect(hintNow()).toBeNull();
    vi.advanceTimersByTime(REACH_HINT_AFTER_MS - 1);
    expect(hintNow()).toBeNull();
    vi.advanceTimersByTime(2);
    expect(hintNow()).toMatch(/Can't reach Maya/);
  });

  test("reaching a member before the timeout cancels it", () => {
    setStatus(withPeers(false));
    vi.advanceTimersByTime(10_000);
    setStatus(withPeers(true));
    vi.advanceTimersByTime(REACH_HINT_AFTER_MS * 2);
    expect(reachActor.snapshot().path[0]).toBe("noWifiHint");
    expect(hintNow()).toBeNull();
  });

  test("the hint clears once someone connects", () => {
    setStatus(withPeers(false));
    vi.advanceTimersByTime(REACH_HINT_AFTER_MS + 1);
    expect(hintNow()).not.toBeNull();
    setStatus(withPeers(true));
    expect(hintNow()).toBeNull();
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
    expect(actor.state.name).toBe("tryingToReachMembers");
    clock.advance(REACH_HINT_AFTER_MS - 1);
    await actor.settled();
    expect(actor.state.name).toBe("waitingBeforeWifiHint");
    clock.advance(1);
    await actor.settled();
    expect(actor.state.name).toBe("showingWifiHint");
  });

  test("reaching someone cancels the wait", async () => {
    const { clock, actor } = setup();
    actor.send(unreachable("Maya"));
    clock.advance(10_000);
    actor.send(reached());
    clock.advance(REACH_HINT_AFTER_MS * 2);
    await actor.settled();
    expect(actor.state.name).toBe("noWifiHint");
  });

  test("reaching someone clears the hint", async () => {
    const { clock, actor } = setup();
    actor.send(unreachable("Maya"));
    clock.advance(REACH_HINT_AFTER_MS);
    await actor.settled();
    actor.send(reached());
    expect(actor.state.name).toBe("noWifiHint");
  });

  test("connecting lasts 15 seconds, then the wait for the hint carries on", async () => {
    const { clock, actor } = setup();
    actor.send(unreachable("Maya"));
    expect(connectionGivenUp(actor.snapshot())).toBe(false);
    clock.advance(CONNECTING_FOR_MS - 1);
    expect(actor.state.name).toBe("tryingToReachMembers");
    clock.advance(1);
    await actor.settled();
    expect(actor.state.name).toBe("waitingBeforeWifiHint");
    expect(connectionGivenUp(actor.snapshot())).toBe(true);
  });

  test("repeated unreachable updates do not delay either timer", async () => {
    const { clock, actor } = setup();
    actor.send(unreachable("Maya"));
    for (let t = 0; t < CONNECTING_FOR_MS; t += 5_000) {
      clock.advance(5_000);
      actor.send(unreachable("Maya"));
    }
    await actor.settled();
    expect(actor.state.name).toBe("waitingBeforeWifiHint");
    for (let t = CONNECTING_FOR_MS; t < REACH_HINT_AFTER_MS; t += 5_000) {
      clock.advance(5_000);
      actor.send(unreachable("Maya"));
    }
    await actor.settled();
    expect(actor.state.name).toBe("showingWifiHint");
  });

  test("reaching someone while connecting shows nothing", () => {
    const { actor } = setup();
    actor.send(unreachable("Maya"));
    actor.send(reached());
    expect(actor.state.name).toBe("noWifiHint");
    expect(connectionGivenUp(actor.snapshot())).toBe(false);
  });

  test("the name updates while trying and in the hint", async () => {
    const { clock, actor } = setup();
    actor.send(unreachable("Maya"));
    actor.send(unreachable("Noor"));
    expect(actor.snapshot().context.name).toBe("Noor");
    clock.advance(REACH_HINT_AFTER_MS);
    await actor.settled();
    actor.send(unreachable("Ola"));
    expect(actor.state.name).toBe("showingWifiHint");
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
    expect(reach.state.name).toBe("tryingToReachMembers");
    expect(reachHintOf(reach.snapshot())).toBeNull();
  });

  test("an unrelated sync change with the same status keeps the wait running", async () => {
    const { clock, sync, reach } = wired(async () => [new Error("offline"), null]);
    clock.advance(20_000);
    await reach.settled();
    sync.send({ type: "REFRESH" } as never);
    await sync.settled();
    expect(sync.snapshot().context.error).toBe("offline");
    clock.advance(10_000);
    await reach.settled();
    expect(reach.state.name).toBe("showingWifiHint");
    expect(reachHintOf(reach.snapshot())).toMatch(/Can't reach Maya/);
  });

  test("a new status object is acted on", () => {
    const { sync, reach } = wired(async () => [null, null]);
    sync.send(statusSeen.create({ status: withPeers(true) }));
    expect(reach.state.name).toBe("noWifiHint");
  });
});
