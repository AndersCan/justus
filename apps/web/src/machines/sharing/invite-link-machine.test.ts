import { VirtualClock } from "@mantaq/core";
import { recordRuns } from "@mantaq/inspect/record";
import { expectAllStatesReached, expectNoDesignErrors } from "@mantaq/inspect";
import { describe, expect, test } from "vite-plus/test";
import { createInviteLinkActor, VALID_FOR_MS, type ValidFor } from "./invite-link-machine";

const FOLDER = "f".repeat(64);

function setup() {
  const clock = VirtualClock();
  const actor = createInviteLinkActor({ clock });
  return { clock, actor };
}

const context = (actor: ReturnType<typeof setup>["actor"]) =>
  actor.snapshot().context as { folderId: string; validFor: ValidFor };
const expiresAt = (actor: ReturnType<typeof setup>["actor"]) =>
  (actor.snapshot().payload as { expiresAt: number }).expiresAt;

describe("invite link machine", () => {
  test("starts with no link and a 1 day choice", () => {
    const { actor } = setup();
    expect(actor.state.name).toBe("noLinkYet");
    expect(context(actor)).toEqual({ folderId: "", validFor: "1d" });
  });

  test.each([
    ["10m", 600_000],
    ["1h", 3_600_000],
    ["1d", 86_400_000],
    ["7d", 604_800_000],
  ] as [ValidFor, number][])("validFor %s ends after %i ms", async (validFor, ms) => {
    const { clock, actor } = setup();
    clock.advance(1_000);
    actor.send({ type: "chooseLinkTime", payload: { validFor } });
    actor.send({ type: "createLink", payload: { folderId: FOLDER } });
    await actor.settled();
    expect(VALID_FOR_MS[validFor]).toBe(ms);
    expect(actor.state.name).toBe("linkMade");
    expect(context(actor).folderId).toBe(FOLDER);
    expect(expiresAt(actor)).toBe(1_000 + ms);
    clock.advance(ms - 1_000);
    await actor.settled();
    expect(actor.state.name).toBe("linkMade");
    clock.advance(1_000);
    await actor.settled();
    expect(actor.state.name).toBe("noLinkYet");
    expect(context(actor).validFor).toBe("1d");
  });

  test("the end time is a whole second", async () => {
    const { clock, actor } = setup();
    clock.advance(1_234);
    actor.send({ type: "chooseLinkTime", payload: { validFor: "10m" } });
    actor.send({ type: "createLink", payload: { folderId: FOLDER } });
    await actor.settled();
    expect(expiresAt(actor)).toBe(601_000);
  });

  test("createLink while a link is made changes nothing", async () => {
    const { clock, actor } = setup();
    actor.send({ type: "chooseLinkTime", payload: { validFor: "1h" } });
    actor.send({ type: "createLink", payload: { folderId: FOLDER } });
    await actor.settled();
    const first = expiresAt(actor);
    clock.advance(60_000);
    actor.send({ type: "createLink", payload: { folderId: "e".repeat(64) } });
    await actor.settled();
    expect(actor.state.name).toBe("linkMade");
    expect(expiresAt(actor)).toBe(first);
    expect(context(actor).folderId).toBe(FOLDER);
  });

  test("an unknown validFor is ignored", async () => {
    const { actor } = setup();
    actor.send({ type: "chooseLinkTime", payload: { validFor: "forever" as ValidFor } });
    await actor.settled();
    expect(context(actor).validFor).toBe("1d");
  });

  test("an empty folderId does nothing", async () => {
    const { actor } = setup();
    actor.send({ type: "createLink", payload: { folderId: "" } });
    await actor.settled();
    expect(actor.state.name).toBe("noLinkYet");
    expect(context(actor).folderId).toBe("");
  });

  test("choosing a time while a link is made changes nothing", async () => {
    const { actor } = setup();
    actor.send({ type: "createLink", payload: { folderId: FOLDER } });
    actor.send({ type: "chooseLinkTime", payload: { validFor: "7d" } });
    await actor.settled();
    expect(context(actor).validFor).toBe("1d");
  });
});

const walkTarget = () => createInviteLinkActor({ clock: VirtualClock() });
const make = recordRuns(createInviteLinkActor);

test("Nils picks 1 hour, sends the link, and the panel offers the picker again once it ends", async () => {
  const clock = VirtualClock();
  const actor = make({ clock });
  actor.send({ type: "chooseLinkTime", payload: { validFor: "1h" } });
  actor.send({ type: "createLink", payload: { folderId: FOLDER } });
  await actor.settled();
  expect(actor.state.name).toBe("linkMade");
  clock.advance(VALID_FOR_MS["1h"]);
  await actor.settled();
  expect(actor.state.name).toBe("noLinkYet");
});

describe("invite link design", () => {
  test("has no design errors", () => {
    expectNoDesignErrors({ id: "inviteLink", create: walkTarget });
  });
  test("reaches every state", () => {
    expectAllStatesReached({ id: "inviteLink", create: walkTarget });
  });
});
