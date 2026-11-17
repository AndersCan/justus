import { recordRuns } from "@mantaq/inspect/record";
import { expect, test } from "vite-plus/test";
import { appLockMachine } from "./app-lock-machine";

const make = recordRuns(appLockMachine);

test("Maya turns on App lock in Settings", async () => {
  const actor = make.create();
  actor.send({ type: "STATUS_READ", payload: { status: { available: true, enabled: false } } });
  actor.send({ type: "SAVE_STARTED" });
  actor.send({ type: "SAVE_ENDED", payload: { status: { available: true, enabled: true } } });
  await actor.settled();
  expect(actor.state.name).toBe("showingLockSwitch");
  expect(actor.snapshot().context.status).toEqual({ available: true, enabled: true });
});

test("Maya's phone has no screen lock, so the App lock switch is greyed out", async () => {
  const actor = make.create();
  actor.send({ type: "STATUS_READ", payload: { status: { available: false, enabled: false } } });
  await actor.settled();
  expect(actor.state.name).toBe("showingLockSwitch");
  expect(actor.snapshot().context.status).toEqual({ available: false, enabled: false });
});
