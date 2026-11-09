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

const savingPort = (saved: [string, number][]): InviteLinkPort => ({
  turnOff: async () => [null, {}],
  saveLinkTime: async (folderId, at) => {
    saved.push([folderId, at]);
    return [null, { ok: true }];
  },
});

function setup(port?: InviteLinkPort) {
  const clock = VirtualClock();
  const actor = createInviteLinkActor({ clock, ...(port ? { port } : {}) });
  return { clock, actor };
}

const context = (actor: ReturnType<typeof setup>["actor"]) =>
  actor.snapshot().context as {
    folderId: string;
    validFor: ValidFor;
    offCode: string;
    offFolderId: string;
    replacedFolderId: string;
    removedName: string;
  };
const expiresAt = (actor: ReturnType<typeof setup>["actor"]) =>
  (actor.snapshot().payload as { expiresAt: number }).expiresAt;

describe("invite link machine", () => {
  test("starts with no link and a 1 day choice", () => {
    const { actor } = setup();
    expect(actor.state.name).toBe("noLinkYet");
    expect(context(actor)).toEqual({
      folderId: "",
      validFor: "1d",
      offCode: "",
      offFolderId: "",
      replacedFolderId: "",
      removedName: "",
    });
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

  test("making a link saves its time once, and not again for the same album", async () => {
    const saved: [string, number][] = [];
    const { actor } = setup(savingPort(saved));
    actor.send({ type: "createLink", payload: { folderId: FOLDER, code: CODE } });
    await actor.settled();
    actor.send({ type: "createLink", payload: { folderId: FOLDER, code: CODE } });
    await actor.settled();
    expect(saved).toEqual([[FOLDER, expiresAt(actor)]]);
  });

  test("a link for another album saves that album's time", async () => {
    const saved: [string, number][] = [];
    const { actor } = setup(savingPort(saved));
    const other = "e".repeat(64);
    actor.send({ type: "createLink", payload: { folderId: FOLDER, code: CODE } });
    await actor.settled();
    actor.send({ type: "createLink", payload: { folderId: other, code: CODE } });
    await actor.settled();
    expect(saved.map(([id]) => id)).toEqual([FOLDER, other]);
    expect(saved[1]?.[1]).toBe(expiresAt(actor));
  });

  test("a failing save goes back to noLinkYet and says so", async () => {
    const { actor } = setup({
      ...savingPort([]),
      saveLinkTime: async () => [new Error("no"), null],
    });
    const seen = outputs(actor);
    actor.send({ type: "createLink", payload: { folderId: FOLDER, code: CODE } });
    await actor.settled();
    expect(actor.state.name).toBe("noLinkYet");
    expect(seen).toContain("linkNotSaved");
  });

  test("while the save is pending the link is not made yet", async () => {
    let finish: (v: [unknown, unknown]) => void = () => {};
    const { actor } = setup({
      ...savingPort([]),
      saveLinkTime: () => new Promise((r) => (finish = r)),
    });
    actor.send({ type: "createLink", payload: { folderId: FOLDER, code: CODE } });
    await Promise.resolve();
    expect(actor.state.name).toBe("savingLinkTime");
    finish([null, { ok: true }]);
    await actor.settled();
    expect(actor.state.name).toBe("linkMade");
  });

  test("a save that throws counts as a failure", async () => {
    const { actor } = setup({
      ...savingPort([]),
      saveLinkTime: async () => {
        throw new Error("boom");
      },
    });
    actor.send({ type: "createLink", payload: { folderId: FOLDER, code: CODE } });
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
  const ok: InviteLinkPort = {
    ...savingPort([]),
    turnOff: async () => [null, { invite: { code: NEW_CODE } }],
  };
  const failing: InviteLinkPort = {
    ...savingPort([]),
    turnOff: async () => [new Error("no"), null],
  };

  test("from linkMade it goes to noLinkYet and remembers the turned-off code", async () => {
    const { actor } = setup(ok);
    const seen = outputs(actor);
    actor.send({ type: "chooseLinkTime", payload: { validFor: "7d" } });
    actor.send({ type: "createLink", payload: { folderId: FOLDER, code: CODE } });
    await actor.settled();
    turnOff(actor);
    await actor.settled();
    expect(actor.state.name).toBe("noLinkYet");
    expect(context(actor)).toEqual({
      folderId: FOLDER,
      validFor: "1d",
      offCode: CODE,
      offFolderId: FOLDER,
      replacedFolderId: "",
      removedName: "",
    });
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
      ...savingPort([]),
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

  test("turning off remembers the album until a link is made for it", async () => {
    const { actor } = setup(ok);
    actor.send({ type: "createLink", payload: { folderId: FOLDER, code: CODE } });
    await actor.settled();
    turnOff(actor);
    await actor.settled();
    expect(context(actor).offFolderId).toBe(FOLDER);
    actor.send({ type: "createLink", payload: { folderId: FOLDER, code: CODE } });
    await actor.settled();
    expect(actor.state.name).toBe("noLinkYet");
    expect(context(actor).offFolderId).toBe(FOLDER);
    actor.send({ type: "createLink", payload: { folderId: FOLDER, code: NEW_CODE } });
    await actor.settled();
    expect(actor.state.name).toBe("linkMade");
    expect(context(actor).offFolderId).toBe("");
  });

  test("turning off album B while A's link is shown remembers B", async () => {
    const { actor } = setup(ok);
    actor.send({ type: "createLink", payload: { folderId: FOLDER, code: CODE } });
    await actor.settled();
    turnOff(actor, OTHER, NEW_CODE);
    await actor.settled();
    expect(actor.state.name).toBe("linkMade");
    expect(context(actor).folderId).toBe(FOLDER);
    expect(context(actor).offFolderId).toBe(OTHER);
    actor.send({ type: "createLink", payload: { folderId: OTHER, code: CODE } });
    await actor.settled();
    expect(actor.state.name).toBe("linkMade");
    expect(context(actor).folderId).toBe(OTHER);
    expect(context(actor).offFolderId).toBe("");
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
      ...savingPort([]),
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

const codeOf = (actor: ReturnType<typeof setup>["actor"]) =>
  (actor.snapshot().payload as { code: string }).code;
const removed = (folderId: string, code: string, name = "Cy") =>
  ({ type: "linkReplaced", payload: { folderId, code, name } }) as const;

describe("invite link after a removal", () => {
  async function shown() {
    const saved: [string, number][] = [];
    const { clock, actor } = setup(savingPort(saved));
    actor.send({ type: "createLink", payload: { folderId: FOLDER, code: CODE } });
    await actor.settled();
    return { clock, actor, saved };
  }

  test("a removal while this album's link is shown goes back to the picker and drops the timer", async () => {
    const { clock, actor } = await shown();
    actor.send({ type: "chooseLinkTime", payload: { validFor: "7d" } });
    actor.send(removed(FOLDER, CODE));
    await actor.settled();
    expect(actor.state.name).toBe("noLinkYet");
    expect(context(actor)).toEqual({
      folderId: FOLDER,
      validFor: "1d",
      offCode: CODE,
      offFolderId: "",
      replacedFolderId: FOLDER,
      removedName: "Cy",
    });
    clock.advance(VALID_FOR_MS["1d"] + 1_000);
    await actor.settled();
    expect(actor.state.name).toBe("noLinkYet");
  });

  test("the old code makes no link; the new code saves its own time and clears the line", async () => {
    const { clock, actor, saved } = await shown();
    actor.send(removed(FOLDER, CODE));
    await actor.settled();
    actor.send({ type: "createLink", payload: { folderId: FOLDER, code: CODE } });
    await actor.settled();
    expect(actor.state.name).toBe("noLinkYet");
    expect(saved).toHaveLength(1);
    clock.advance(5_000);
    actor.send({ type: "createLink", payload: { folderId: FOLDER, code: NEW_CODE } });
    await actor.settled();
    expect(actor.state.name).toBe("linkMade");
    expect(codeOf(actor)).toBe(NEW_CODE);
    expect(saved).toEqual([
      [FOLDER, VALID_FOR_MS["1d"]],
      [FOLDER, 5_000 + VALID_FOR_MS["1d"]],
    ]);
    expect(context(actor).replacedFolderId).toBe("");
    expect(context(actor).removedName).toBe("");
  });

  test("a new code for the same album saves a new time even without a removal message", async () => {
    const { actor, saved } = await shown();
    actor.send({ type: "createLink", payload: { folderId: FOLDER, code: NEW_CODE } });
    await actor.settled();
    expect(actor.state.name).toBe("linkMade");
    expect(codeOf(actor)).toBe(NEW_CODE);
    expect(saved).toHaveLength(2);
  });

  test("a removal from another album keeps this album's link and refuses the old code", async () => {
    const { actor } = await shown();
    const before = expiresAt(actor);
    actor.send(removed("e".repeat(64), "d".repeat(64)));
    await actor.settled();
    expect(actor.state.name).toBe("linkMade");
    expect(expiresAt(actor)).toBe(before);
    expect(context(actor).offCode).toBe("d".repeat(64));
    expect(context(actor).replacedFolderId).toBe("");
    actor.send({ type: "createLink", payload: { folderId: "e".repeat(64), code: "d".repeat(64) } });
    await actor.settled();
    expect(actor.state.name).toBe("linkMade");
    expect(context(actor).folderId).toBe(FOLDER);
  });

  test("a removal with no link shown sets only the refused code; a second one renames", async () => {
    const { actor } = setup();
    actor.send(removed(FOLDER, CODE));
    await actor.settled();
    expect(context(actor)).toEqual({
      folderId: "",
      validFor: "1d",
      offCode: CODE,
      offFolderId: "",
      replacedFolderId: "",
      removedName: "",
    });
    const second = setup(savingPort([]));
    second.actor.send({ type: "createLink", payload: { folderId: FOLDER, code: CODE } });
    await second.actor.settled();
    second.actor.send(removed(FOLDER, CODE, "Cy"));
    second.actor.send(removed(FOLDER, NEW_CODE, "Dee"));
    await second.actor.settled();
    expect(context(second.actor).removedName).toBe("Dee");
    expect(context(second.actor).offCode).toBe(NEW_CODE);
  });

  test("empty folder or code is ignored", async () => {
    const { actor } = await shown();
    actor.send(removed("", CODE));
    actor.send(removed(FOLDER, ""));
    await actor.settled();
    expect(actor.state.name).toBe("linkMade");
    expect(context(actor).offCode).toBe("");
    const idle = setup();
    idle.actor.send(removed(FOLDER, ""));
    idle.actor.send(removed("", CODE));
    await idle.actor.settled();
    expect(context(idle.actor).offCode).toBe("");
  });

  test("copying another album's link and then this album's new link clears the removal line", async () => {
    const { actor } = await shown();
    actor.send(removed(FOLDER, CODE));
    await actor.settled();
    actor.send({ type: "createLink", payload: { folderId: OTHER, code: "9".repeat(64) } });
    await actor.settled();
    expect(context(actor).replacedFolderId).toBe(FOLDER);
    actor.send({ type: "createLink", payload: { folderId: FOLDER, code: NEW_CODE } });
    await actor.settled();
    expect(actor.state.name).toBe("linkMade");
    expect(context(actor).replacedFolderId).toBe("");
    expect(context(actor).removedName).toBe("");
  });

  test("a failed turn-off restores the link with its code, so Copy saves no new time", async () => {
    const saved: [string, number][] = [];
    const { actor } = setup({
      ...savingPort(saved),
      turnOff: async () => [new Error("no"), null],
    });
    actor.send({ type: "createLink", payload: { folderId: FOLDER, code: CODE } });
    await actor.settled();
    turnOff(actor, FOLDER, CODE);
    await actor.settled();
    expect(actor.state.name).toBe("linkMade");
    expect(codeOf(actor)).toBe(CODE);
    actor.send({ type: "createLink", payload: { folderId: FOLDER, code: CODE } });
    await actor.settled();
    expect(saved).toHaveLength(1);
  });

  test("an empty code does not overwrite a refused code when no link is shown", async () => {
    const { actor } = setup();
    actor.send(removed(FOLDER, CODE));
    actor.send(removed(FOLDER, ""));
    await actor.settled();
    expect(context(actor).offCode).toBe(CODE);
  });

  test("turning off the links clears the replaced line", async () => {
    const { actor } = await shown();
    actor.send(removed(FOLDER, CODE));
    await actor.settled();
    actor.send({ type: "turnOffLink", payload: { folderId: FOLDER, code: NEW_CODE } });
    await actor.settled();
    expect(context(actor).replacedFolderId).toBe("");
    expect(context(actor).removedName).toBe("");
    expect(context(actor).offFolderId).toBe(FOLDER);
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

test("Nils removes someone while his link is shown, and the panel offers the picker again", async () => {
  const actor = make({ clock: VirtualClock(), port: savingPort([]) });
  actor.send({ type: "createLink", payload: { folderId: FOLDER, code: CODE } });
  await actor.settled();
  actor.send(removed(FOLDER, CODE));
  await actor.settled();
  expect(actor.state.name).toBe("noLinkYet");
});

test("Nils turns off the links he sent", async () => {
  const actor = make({
    clock: VirtualClock(),
    port: { ...savingPort([]), turnOff: async () => [null, { invite: { code: NEW_CODE } }] },
  });
  actor.send({ type: "createLink", payload: { folderId: FOLDER, code: CODE } });
  await actor.settled();
  actor.send({ type: "turnOffLink", payload: { folderId: FOLDER, code: CODE } });
  await actor.settled();
  expect(actor.state.name).toBe("noLinkYet");
});

test("Nils turns off the links, it fails, and his link stays shown", async () => {
  const actor = make({ clock: VirtualClock() });
  actor.send({ type: "createLink", payload: { folderId: FOLDER, code: CODE } });
  await actor.settled();
  actor.send({ type: "turnOffLink", payload: { folderId: FOLDER, code: CODE } });
  actor.inject({ type: "linkOffFailed", payload: { folderId: FOLDER } });
  await actor.settled();
  expect(actor.state.name).toBe("linkMade");
});

describe("invite link design", () => {
  test("has no design errors", () => {
    expectNoDesignErrors({ id: "inviteLink", create: walkTarget });
  });
  test("reaches every state", () => {
    expectAllStatesReached({ id: "inviteLink", create: walkTarget });
  });
});
