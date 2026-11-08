import { VirtualClock } from "@mantaq/core";
import { recordRuns } from "@mantaq/inspect/record";
import { expect, test } from "vite-plus/test";
import { REACH_HINT_AFTER_MS } from "../utils/reach-hint";
import { createReachActor } from "./reach-hint-machine";

const make = recordRuns(createReachActor);

test("Nobody in Trip can be reached, and after a while Anna sees the WiFi hint", async () => {
  const clock = VirtualClock();
  const actor = make({ clock });
  actor.send({ type: "UNREACHABLE", payload: { name: "Nils" } });
  clock.advance(REACH_HINT_AFTER_MS);
  await actor.settled();
  expect(actor.state.name).toBe("showingWifiHint");
});
