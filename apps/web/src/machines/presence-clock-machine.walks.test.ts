import { VirtualClock } from "@mantaq/core";
import { recordRuns } from "@mantaq/inspect/record";
import { expect, test } from "vite-plus/test";
import { PRESENCE_TICK_MS } from "../utils/presence";
import { membersChanged, presenceClockMachine } from "./presence-clock-machine";

const make = recordRuns(presenceClockMachine);

test("Ben's phone goes off, Ada's clock keeps counting, and Ben comes back", async () => {
  const clock = VirtualClock();
  const actor = make.create({ clock });
  actor.send(membersChanged.create({ someoneNotConnected: true }));
  clock.advance(PRESENCE_TICK_MS * 2);
  await actor.settled();
  expect(actor.snapshot().context.now).toBe(PRESENCE_TICK_MS * 2);
  actor.send(membersChanged.create({ someoneNotConnected: false }));
  expect(actor.state.name).toBe("everyoneConnected");
});
