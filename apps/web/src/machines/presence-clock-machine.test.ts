import { VirtualClock } from "@mantaq/core";
import { expect, test } from "vite-plus/test";
import { PRESENCE_TICK_MS } from "../utils/presence";
import { membersChanged, presenceClockMachine } from "./presence-clock-machine";

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
