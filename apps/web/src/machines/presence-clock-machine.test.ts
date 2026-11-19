import { VirtualClock } from "@mantaq/core";
import type { SyncStatus } from "@justus/core";
import { describe, expect, test } from "vite-plus/test";
import { PRESENCE_TICK_MS } from "../utils/presence";
import {
  membersChanged,
  presenceClockMachine,
  wirePresenceClockToSync,
} from "./presence-clock-machine";
import { statusSeen, syncMachine } from "./sync-machine";

const away = membersChanged.create({ someoneNotConnected: true });
const back = membersChanged.create({ someoneNotConnected: false });

test("someone away starts the clock and it moves on every 15 s", () => {
  const clock = VirtualClock();
  const actor = presenceClockMachine.create({ clock });
  expect(actor.snapshot().path[0]).toBe("everyoneConnected");
  actor.send(away);
  expect(actor.snapshot().path[0]).toBe("someoneNotConnected");
  clock.advance(PRESENCE_TICK_MS);
  expect(actor.snapshot().context.now).toBe(15_000);
  clock.advance(PRESENCE_TICK_MS);
  expect(actor.snapshot().context.now).toBe(30_000);
});

test("a second away status does not restart the interval", () => {
  const clock = VirtualClock();
  const actor = presenceClockMachine.create({ clock });
  actor.send(away);
  clock.advance(10_000);
  actor.send(away);
  clock.advance(5_000);
  expect(actor.snapshot().context.now).toBe(15_000);
  clock.advance(15_000);
  expect(actor.snapshot().context.now).toBe(30_000);
});

test("everyone back stops the ticks", () => {
  const clock = VirtualClock();
  const actor = presenceClockMachine.create({ clock });
  actor.send(away);
  clock.advance(20_000);
  actor.send(back);
  expect(actor.snapshot().path[0]).toBe("everyoneConnected");
  expect(actor.snapshot().context.now).toBe(20_000);
  expect(clock.hasPending()).toBe(false);
});

test("an all-connected status changes nothing", () => {
  const clock = VirtualClock();
  const actor = presenceClockMachine.create({ clock });
  clock.advance(5_000);
  actor.send(back);
  expect(actor.snapshot().path[0]).toBe("everyoneConnected");
  expect(clock.hasPending()).toBe(false);
});

test("the first away status stamps now, so a friend who just left is still inside the 30 s", () => {
  const clock = VirtualClock();
  const actor = presenceClockMachine.create({ clock });
  clock.advance(600_000);
  actor.send(away);
  expect(actor.snapshot().context.now).toBe(600_000);
});

describe("wirePresenceClockToSync", () => {
  const status = (others: boolean[]) =>
    ({
      members: [
        { key: "me", name: "Ada", admin: true, connected: false },
        ...others.map((connected, i) => ({ key: `k${i}`, name: `F${i}`, admin: false, connected })),
      ],
    }) as SyncStatus;

  function wired(first: SyncStatus | null) {
    const clock = VirtualClock();
    const sync = syncMachine.create({
      clock,
      gateway: { status: async () => [null, null] } as never,
    });
    if (first !== null) sync.send(statusSeen.create({ status: first }));
    const actor = presenceClockMachine.create({ clock });
    wirePresenceClockToSync(actor, sync);
    return { sync, actor };
  }

  test("a friend not connected starts the clock", () => {
    expect(wired(status([true, false])).actor.state.name).toBe("someoneNotConnected");
  });

  test("everyone else connected keeps it still, even when the own row reads not connected", () => {
    expect(wired(status([true, true])).actor.state.name).toBe("everyoneConnected");
  });

  test("no status yet keeps it still", () => {
    expect(wired(null).actor.state.name).toBe("everyoneConnected");
  });

  test("a new status with everyone back stops it", () => {
    const { sync, actor } = wired(status([false]));
    sync.send(statusSeen.create({ status: status([true]) }));
    expect(actor.state.name).toBe("everyoneConnected");
  });
});
