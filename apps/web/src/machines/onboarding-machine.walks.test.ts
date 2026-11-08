import { VirtualClock } from "@mantaq/core";
import { recordRuns } from "@mantaq/inspect/record";
import { expect, test } from "vite-plus/test";
import { createOnboardingActor } from "./onboarding-machine";

const make = recordRuns(createOnboardingActor);

type Actor = ReturnType<typeof make>;

function typeNameAndSave(actor: Actor) {
  actor.send({ type: "SKIP" });
  actor.send({ type: "EDIT_NAME", payload: { name: "Maya" } });
  actor.send({ type: "SAVE_PROFILE" });
  actor.inject({ type: "SAVED", payload: { name: "Maya" } });
}

test("Maya skips the cards, saves her name and turns on App lock", async () => {
  const actor = make({ clock: VirtualClock() });
  actor.send({
    type: "LOCK_STATUS_READ",
    payload: { status: { available: true, enabled: false } },
  });
  typeNameAndSave(actor);
  await actor.settled();
  expect(actor.state.name).toBe("offeringAppLock");
  actor.send({ type: "TURN_ON_APP_LOCK" });
  actor.inject({ type: "APP_LOCK_TURNED_ON" });
  await actor.settled();
  expect(actor.state.name).toBe("choosingCreateOrJoin");
  expect(actor.snapshot().context.lock?.enabled).toBe(true);
});

test("Maya saves her name and says Not now to App lock", async () => {
  const actor = make({ clock: VirtualClock() });
  actor.send({
    type: "LOCK_STATUS_READ",
    payload: { status: { available: true, enabled: false } },
  });
  typeNameAndSave(actor);
  await actor.settled();
  actor.send({ type: "SKIP_APP_LOCK" });
  await actor.settled();
  expect(actor.state.name).toBe("choosingCreateOrJoin");
  expect(actor.snapshot().context.lock?.enabled).toBe(false);
});

test("Maya's phone has no screen lock, so she is never asked about App lock", async () => {
  const actor = make({ clock: VirtualClock() });
  actor.send({
    type: "LOCK_STATUS_READ",
    payload: { status: { available: false, enabled: false } },
  });
  typeNameAndSave(actor);
  await actor.settled();
  expect(actor.state.name).toBe("choosingCreateOrJoin");
});

test("Maya cancels the phone's unlock prompt and is back on Lock Justus?", async () => {
  const actor = make({ clock: VirtualClock() });
  actor.send({
    type: "LOCK_STATUS_READ",
    payload: { status: { available: true, enabled: false } },
  });
  typeNameAndSave(actor);
  await actor.settled();
  actor.send({ type: "TURN_ON_APP_LOCK" });
  actor.inject({ type: "APP_LOCK_LEFT_OFF" });
  await actor.settled();
  expect(actor.state.name).toBe("offeringAppLock");
  expect(actor.snapshot().context.error).toBeNull();
});

test("App lock could not be turned on, so Maya sees why on Lock Justus?", async () => {
  const actor = make({ clock: VirtualClock() });
  actor.send({
    type: "LOCK_STATUS_READ",
    payload: { status: { available: true, enabled: false } },
  });
  typeNameAndSave(actor);
  await actor.settled();
  actor.send({ type: "TURN_ON_APP_LOCK" });
  actor.inject({
    type: "APP_LOCK_FAILED",
    payload: { message: "App lock could not be turned on" },
  });
  await actor.settled();
  expect(actor.state.name).toBe("offeringAppLock");
  expect(actor.snapshot().context.error).toBe("App lock could not be turned on");
});

test("Maya's name could not be saved, so she is back on the name step", async () => {
  const actor = make({ clock: VirtualClock() });
  actor.send({ type: "SKIP" });
  actor.send({ type: "EDIT_NAME", payload: { name: "Maya" } });
  actor.send({ type: "SAVE_PROFILE" });
  actor.inject({ type: "SAVE_FAILED", payload: { message: "Your name could not be saved" } });
  await actor.settled();
  expect(actor.state.name).toBe("askingForName");
  expect(actor.snapshot().context.error).toBe("Your name could not be saved");
});
