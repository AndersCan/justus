import { VirtualClock } from "@mantaq/core";
import { recordRuns } from "@mantaq/inspect/record";
import { expectAllStatesReached, expectNoDesignErrors } from "@mantaq/inspect";
import { onOutput } from "@mantaq/sugar";
import { describe, expect, test } from "vite-plus/test";
import {
  createInviteLinkActor,
  VALID_FOR_MS,
  type InviteLinkPort,
  type ValidFor,
} from "./invite-link-machine";

const FOLDER = "f".repeat(64);
const CODE = "c".repeat(64);

function setup(port?: InviteLinkPort) {
  const clock = VirtualClock();
  const actor = createInviteLinkActor({ clock, ...(port ? { port } : {}) });
  return { clock, actor };
}

const context = (actor: ReturnType<typeof setup>["actor"]) =>
  actor.snapshot().context as { folderId: string; validFor: ValidFor; offCode: string };
const expiresAt = (actor: ReturnType<typeof setup>["actor"]) =>
  (actor.snapshot().payload as { expiresAt: number }).expiresAt;

describe("invite link machine", () => {
  test("starts with no link and a 1 day choice", () => {
    const { actor } = setup();
    expect(actor.state.name).toBe("noLinkYet");
    expect(context(actor)).toEqual({ folderId: "", validFor: "1d", offCode: "" });
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
    actor.send({ type: "createLink", payload: { folderId: FOLDER, code: CODE } });
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
    actor.send({ type: "createLink", payload: { folderId: FOLDER, code: CODE } });
    await actor.settled();
    expect(expiresAt(actor)).toBe(601_000);
  });

  test("createLink for the same album while a link is made changes nothing", async () => {
    const { clock, actor } = setup();
    actor.send({ type: "chooseLinkTime", payload: { validFor: "1h" } });
    actor.send({ type: "createLink", payload: { folderId: FOLDER, code: CODE } });
    await actor.settled();
    const first = expiresAt(actor);
    clock.advance(60_000);
    actor.send({ type: "createLink", payload: { folderId: FOLDER, code: CODE } });
    await actor.settled();
    expect(actor.state.name).toBe("linkMade");
    expect(expiresAt(actor)).toBe(first);
    expect(context(actor).folderId).toBe(FOLDER);
  });

  test("a link for another album gets the time picked for it", async () => {
    const { clock, actor } = setup();
    const other = "e".repeat(64);
    actor.send({ type: "chooseLinkTime", payload: { validFor: "7d" } });
    actor.send({ type: "createLink", payload: { folderId: FOLDER, code: CODE } });
    await actor.settled();
    clock.advance(60_000);
    actor.send({ type: "chooseLinkTime", payload: { validFor: "10m" } });
    actor.send({ type: "createLink", payload: { folderId: other, code: CODE } });
    await actor.settled();
    expect(actor.state.name).toBe("linkMade");
    expect(context(actor).folderId).toBe(other);
    expect(expiresAt(actor)).toBe(60_000 + VALID_FOR_MS["10m"]);
    clock.advance(VALID_FOR_MS["10m"]);
    await actor.settled();
    expect(actor.state.name).toBe("noLinkYet");
  });

  test("an empty folderId while a link is made changes nothing", async () => {
    const { actor } = setup();
    actor.send({ type: "createLink", payload: { folderId: FOLDER, code: CODE } });
    await actor.settled();
    const first = expiresAt(actor);
    actor.send({ type: "createLink", payload: { folderId: "", code: CODE } });
    await actor.settled();
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
    actor.send({ type: "createLink", payload: { folderId: "", code: CODE } });
    await actor.settled();
    expect(actor.state.name).toBe("noLinkYet");
    expect(context(actor).folderId).toBe("");
  });

  test("choosing a time while a link is made keeps that link's end time", async () => {
    const { actor } = setup();
    actor.send({ type: "createLink", payload: { folderId: FOLDER, code: CODE } });
    await actor.settled();
    const first = expiresAt(actor);
    actor.send({ type: "chooseLinkTime", payload: { validFor: "7d" } });
    await actor.settled();
    expect(actor.state.name).toBe("linkMade");
    expect(expiresAt(actor)).toBe(first);
    expect(context(actor).folderId).toBe(FOLDER);
  });
});

const OTHER = "e".repeat(64);
const NEW_CODE = "d".repeat(64);
const turnOff = (actor: ReturnType<typeof setup>["actor"], folderId = FOLDER, code = CODE) =>
  actor.send({ type: "turnOffLink", payload: { folderId, code } });
const outputs = (actor: ReturnType<typeof setup>["actor"]) => {
  const seen: string[] = [];
  onOutput(actor, (e) => seen.push(e.type));
  return seen;
};

describe("turning off links", () => {
  const ok: InviteLinkPort = { turnOff: async () => [null, { invite: { code: NEW_CODE } }] };
  const failing: InviteLinkPort = { turnOff: async () => [new Error("no"), null] };

  test("from linkMade it goes to noLinkYet and remembers the turned-off code", async () => {
    const { actor } = setup(ok);
    const seen = outputs(actor);
    actor.send({ type: "chooseLinkTime", payload: { validFor: "7d" } });
    actor.send({ type: "createLink", payload: { folderId: FOLDER, code: CODE } });
    await actor.settled();
    turnOff(actor);
    await actor.settled();
    expect(actor.state.name).toBe("noLinkYet");
    expect(context(actor)).toEqual({ folderId: FOLDER, validFor: "1d", offCode: CODE });
    expect(seen).toContain("linkTurnedOff");
  });

  test("from noLinkYet it also turns off", async () => {
    const { actor } = setup(ok);
    turnOff(actor);
    await actor.settled();
    expect(actor.state.name).toBe("noLinkYet");
    expect(context(actor).offCode).toBe(CODE);
  });

  test("a failure goes back to the same link and says so", async () => {
    const { clock, actor } = setup(failing);
    const seen = outputs(actor);
    clock.advance(1_000);
    actor.send({ type: "createLink", payload: { folderId: FOLDER, code: CODE } });
    await actor.settled();
    const first = expiresAt(actor);
    turnOff(actor);
    await actor.settled();
    expect(actor.state.name).toBe("linkMade");
    expect(expiresAt(actor)).toBe(first);
    expect(context(actor).offCode).toBe("");
    expect(seen).toContain("turnOffFailed");
  });

  test("a failure from noLinkYet stays noLinkYet", async () => {
    const { actor } = setup(failing);
    turnOff(actor);
    await actor.settled();
    expect(actor.state.name).toBe("noLinkYet");
  });

  test("a port that throws counts as a failure", async () => {
    const { actor } = setup({
      turnOff: async () => {
        throw new Error("boom");
      },
    });
    const seen = outputs(actor);
    turnOff(actor);
    await actor.settled();
    expect(actor.state.name).toBe("noLinkYet");
    expect(seen).toContain("turnOffFailed");
  });

  test("turning off album B keeps album A's link", async () => {
    const { actor } = setup(ok);
    actor.send({ type: "createLink", payload: { folderId: FOLDER, code: CODE } });
    await actor.settled();
    const first = expiresAt(actor);
    turnOff(actor, OTHER, NEW_CODE);
    await actor.settled();
    expect(actor.state.name).toBe("linkMade");
    expect(context(actor).folderId).toBe(FOLDER);
    expect(expiresAt(actor)).toBe(first);
  });

  test("createLink with the turned-off code stays put", async () => {
    const { actor } = setup(ok);
    turnOff(actor);
    await actor.settled();
    actor.send({ type: "createLink", payload: { folderId: FOLDER, code: CODE } });
    await actor.settled();
    expect(actor.state.name).toBe("noLinkYet");
    actor.send({ type: "createLink", payload: { folderId: FOLDER, code: NEW_CODE } });
    await actor.settled();
    expect(actor.state.name).toBe("linkMade");
  });

  test("a link that ended while turning off flips to noLinkYet", async () => {
    let release: () => void = () => {};
    const slow: InviteLinkPort = {
      turnOff: () => new Promise((resolve) => (release = () => resolve([new Error("x"), null]))),
    };
    const { clock, actor } = setup(slow);
    actor.send({ type: "chooseLinkTime", payload: { validFor: "10m" } });
    actor.send({ type: "createLink", payload: { folderId: FOLDER, code: CODE } });
    await actor.settled();
    turnOff(actor);
    expect(actor.state.name).toBe("turningOff");
    clock.advance(VALID_FOR_MS["10m"] + 1_000);
    release();
    await actor.settled();
    clock.advance(0);
    await actor.settled();
    expect(actor.state.name).toBe("noLinkYet");
  });

  test("an empty folderId or code is ignored", async () => {
    const { actor } = setup(ok);
    turnOff(actor, "", CODE);
    turnOff(actor, FOLDER, "");
    await actor.settled();
    expect(actor.state.name).toBe("noLinkYet");
    expect(context(actor).offCode).toBe("");
  });
});

const walkTarget = () => createInviteLinkActor({ clock: VirtualClock() });
const make = recordRuns(createInviteLinkActor);

test("Nils picks 1 hour, sends the link, and the panel offers the picker again once it ends", async () => {
  const clock = VirtualClock();
  const actor = make({ clock });
  actor.send({ type: "chooseLinkTime", payload: { validFor: "1h" } });
  actor.send({ type: "createLink", payload: { folderId: FOLDER, code: CODE } });
  await actor.settled();
  expect(actor.state.name).toBe("linkMade");
  clock.advance(VALID_FOR_MS["1h"]);
  await actor.settled();
  expect(actor.state.name).toBe("noLinkYet");
});

test("Nils turns off the links he sent", async () => {
  const actor = make({
    clock: VirtualClock(),
    port: { turnOff: async () => [null, { invite: { code: NEW_CODE } }] },
  });
  actor.send({ type: "createLink", payload: { folderId: FOLDER, code: CODE } });
  await actor.settled();
  actor.send({ type: "turnOffLink", payload: { folderId: FOLDER, code: CODE } });
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
