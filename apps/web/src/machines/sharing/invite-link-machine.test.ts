import { VirtualClock } from "@mantaq/core";
import { recordRuns } from "@mantaq/inspect/record";
import { expectAllStatesReached, expectNoDesignErrors } from "@mantaq/inspect";
import { onOutput } from "@mantaq/sugar";
import { describe, expect, test } from "vite-plus/test";
import {
  inviteLinkMachine,
  linkKindOf,
  VALID_FOR_MS,
  type InviteLinkPort,
  type ValidFor,
} from "./invite-link-machine";

const FOLDER = "f".repeat(64);
const CODE = "c".repeat(64);

const savingPort = (saved: [string, number][]): InviteLinkPort => ({
  turnOff: async () => [null, {}],
  endLink: async () => [null, { ok: true }],
  saveLinkTime: async (folderId, at) => {
    saved.push([folderId, at]);
    return [null, { ok: true }];
  },
});

function setup(port?: InviteLinkPort) {
  const clock = VirtualClock();
  const actor = inviteLinkMachine.create({ clock, ...(port ? { port } : {}) });
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
    lastExpiresAt: number;
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
      lastExpiresAt: 0,
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

/** A port whose saves wait until the test answers them, in order. */
function heldSaves() {
  const saved: number[] = [];
  const answers: ((outcome: [unknown, unknown]) => void)[] = [];
  const port: InviteLinkPort = {
    turnOff: async () => [null, {}],
    endLink: async () => [null, {}],
    saveLinkTime: (_folderId, at) => {
      saved.push(at);
      return new Promise((resolve) => answers.push(resolve));
    },
  };
  const answer = async (index: number, outcome: [unknown, unknown]) => {
    answers[index]?.(outcome);
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { saved, port, answer };
}
const SAVED: [unknown, unknown] = [null, { ok: true }];

describe("a time picked while the link's time saves", () => {
  test("is saved after the first save, and the link works for it", async () => {
    const { saved, port, answer } = heldSaves();
    const { clock, actor } = setup(port);
    const states: string[] = [];
    actor.on("transition", { fn: (t) => t.transitioned && states.push(t.to) });
    actor.send({ type: "createLink", payload: { folderId: FOLDER, code: CODE } });
    actor.send({ type: "chooseLinkTime", payload: { validFor: "7d" } });
    clock.advance(2_000);
    await answer(0, SAVED);
    expect(actor.state.name).toBe("savingLinkTime");
    expect(saved).toEqual([VALID_FOR_MS["1d"], 2_000 + VALID_FOR_MS["7d"]]);
    await answer(1, SAVED);
    expect(actor.state.name).toBe("linkMade");
    expect(expiresAt(actor)).toBe(2_000 + VALID_FOR_MS["7d"]);
    expect(states).toEqual(["savingLinkTime", "savingLinkTime", "linkMade"]);
  });

  test("turning the links off while the time saves makes no link, and a late answer changes nothing", async () => {
    const { saved, port, answer } = heldSaves();
    const { actor } = setup(port);
    const seen = outputs(actor);
    actor.send({ type: "createLink", payload: { folderId: FOLDER, code: CODE } });
    actor.send({ type: "chooseLinkTime", payload: { validFor: "7d" } });
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
      lastExpiresAt: VALID_FOR_MS["1d"],
    });
    expect(seen).toEqual(["linkTurnedOff"]);
    await answer(0, SAVED);
    expect(actor.state.name).toBe("noLinkYet");
    expect(saved).toHaveLength(1);
  });
});

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
      lastExpiresAt: VALID_FOR_MS["7d"],
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
    expect(codeOf(actor)).toBe(CODE);
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
      lastExpiresAt: VALID_FOR_MS["1d"],
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
      lastExpiresAt: 0,
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

const make = recordRuns(inviteLinkMachine);

test("Nils picks 1 hour, sends the link, and the panel offers the picker again once it ends", async () => {
  const clock = VirtualClock();
  const actor = make.create({ clock });
  actor.send({ type: "chooseLinkTime", payload: { validFor: "1h" } });
  actor.send({ type: "createLink", payload: { folderId: FOLDER, code: CODE } });
  await actor.settled();
  expect(actor.state.name).toBe("linkMade");
  clock.advance(VALID_FOR_MS["1h"]);
  await actor.settled();
  expect(actor.state.name).toBe("noLinkYet");
});

test("Nils taps Copy, picks 7 days while the link's time saves, and the link works for 7 days", async () => {
  const actor = make.create({ clock: VirtualClock() });
  actor.send({ type: "createLink", payload: { folderId: FOLDER, code: CODE } });
  actor.send({ type: "chooseLinkTime", payload: { validFor: "7d" } });
  await actor.settled();
  expect(actor.state.name).toBe("linkMade");
  expect(expiresAt(actor)).toBe(VALID_FOR_MS["7d"]);
});

test("Nils removes someone while his link is shown, and the panel offers the picker again", async () => {
  const actor = make.create({ clock: VirtualClock(), port: savingPort([]) });
  actor.send({ type: "createLink", payload: { folderId: FOLDER, code: CODE } });
  await actor.settled();
  actor.send(removed(FOLDER, CODE));
  await actor.settled();
  expect(actor.state.name).toBe("noLinkYet");
});

test("Nils turns off the links he sent", async () => {
  const actor = make.create({
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
  const actor = make.create({ clock: VirtualClock() });
  actor.send({ type: "createLink", payload: { folderId: FOLDER, code: CODE } });
  await actor.settled();
  actor.send({ type: "turnOffLink", payload: { folderId: FOLDER, code: CODE } });
  actor.inject({ type: "linkOffFailed", payload: { folderId: FOLDER } });
  await actor.settled();
  expect(actor.state.name).toBe("linkMade");
});

const endingPort = (ended: [string, number][], fail = false): InviteLinkPort => ({
  ...savingPort([]),
  endLink: async (folderId, endsAt) => {
    ended.push([folderId, endsAt]);
    return fail ? [new Error("no"), null] : [null, { ok: true }];
  },
});

const okTurnOff: InviteLinkPort = {
  ...savingPort([]),
  turnOff: async () => [null, { invite: { code: NEW_CODE } }],
};

describe("more than one link", () => {
  test("makeNewLink while a link works saves a second end time", async () => {
    const saved: [string, number][] = [];
    const { actor } = setup(savingPort(saved));
    actor.send({ type: "createLink", payload: { folderId: FOLDER, code: CODE } });
    await actor.settled();
    actor.send({ type: "chooseLinkTime", payload: { validFor: "7d" } });
    actor.send({ type: "makeNewLink", payload: { folderId: FOLDER, code: CODE } });
    await actor.settled();
    expect(saved).toEqual([
      [FOLDER, VALID_FOR_MS["1d"]],
      [FOLDER, VALID_FOR_MS["7d"]],
    ]);
    expect(actor.state.name).toBe("linkMade");
    expect(expiresAt(actor)).toBe(VALID_FOR_MS["7d"]);
  });

  test("two links of the same time made together end a second apart", async () => {
    const saved: [string, number][] = [];
    const { actor } = setup(savingPort(saved));
    actor.send({ type: "makeNewLink", payload: { folderId: FOLDER, code: CODE } });
    await actor.settled();
    actor.send({ type: "makeNewLink", payload: { folderId: FOLDER, code: CODE } });
    await actor.settled();
    expect(saved.map(([, at]) => at)).toEqual([VALID_FOR_MS["1d"], VALID_FOR_MS["1d"] + 1000]);
  });

  test("a shorter link after a longer one keeps its own time", async () => {
    const { actor } = setup();
    actor.send({ type: "chooseLinkTime", payload: { validFor: "7d" } });
    actor.send({ type: "makeNewLink", payload: { folderId: FOLDER, code: CODE } });
    await actor.settled();
    actor.send({ type: "chooseLinkTime", payload: { validFor: "10m" } });
    actor.send({ type: "makeNewLink", payload: { folderId: FOLDER, code: CODE } });
    await actor.settled();
    expect(expiresAt(actor)).toBe(VALID_FOR_MS["10m"]);
  });

  test("makeNewLink with no album or the turned-off code does nothing", async () => {
    const { actor } = setup(okTurnOff);
    actor.send({ type: "makeNewLink", payload: { folderId: "", code: CODE } });
    await actor.settled();
    expect(actor.state.name).toBe("noLinkYet");
    turnOff(actor);
    await actor.settled();
    actor.send({ type: "makeNewLink", payload: { folderId: FOLDER, code: CODE } });
    await actor.settled();
    expect(actor.state.name).toBe("noLinkYet");
  });

  test("makeNewLink while the time saves is ignored", async () => {
    const saved: [string, number][] = [];
    const { actor } = setup(savingPort(saved));
    actor.send({ type: "makeNewLink", payload: { folderId: FOLDER, code: CODE } });
    actor.send({ type: "makeNewLink", payload: { folderId: FOLDER, code: CODE } });
    await actor.settled();
    expect(saved).toHaveLength(1);
  });
});

describe("ending one link", () => {
  const link = { folderId: FOLDER, madeAt: 0, endsAt: VALID_FOR_MS["7d"] };

  async function withLink(port: InviteLinkPort) {
    const s = setup(port);
    s.actor.send({ type: "createLink", payload: { folderId: FOLDER, code: CODE } });
    await s.actor.settled();
    return s;
  }

  test("ending another row keeps the shown link", async () => {
    const ended: [string, number][] = [];
    const { actor } = await withLink(endingPort(ended));
    const seen = outputs(actor);
    actor.send({ type: "endLink", payload: link });
    await actor.settled();
    expect(ended).toEqual([[FOLDER, link.endsAt]]);
    expect(actor.state.name).toBe("linkMade");
    expect(expiresAt(actor)).toBe(VALID_FOR_MS["1d"]);
    expect(seen).toContain("linkEnded");
  });

  test("ending the shown link goes to noLinkYet and keeps the picked time", async () => {
    const { actor } = await withLink(endingPort([]));
    actor.send({ type: "chooseLinkTime", payload: { validFor: "1h" } });
    actor.send({ type: "endLink", payload: { ...link, endsAt: VALID_FOR_MS["1d"] } });
    await actor.settled();
    expect(actor.state.name).toBe("noLinkYet");
    expect(context(actor).validFor).toBe("1h");
  });

  test("ending a link with no link shown ends it and stays noLinkYet", async () => {
    const ended: [string, number][] = [];
    const { actor } = setup(endingPort(ended));
    actor.send({ type: "endLink", payload: link });
    await actor.settled();
    expect(ended).toHaveLength(1);
    expect(actor.state.name).toBe("noLinkYet");
  });

  test("a failure goes back to the shown link and says so", async () => {
    const { actor } = await withLink(endingPort([], true));
    const seen = outputs(actor);
    actor.send({ type: "endLink", payload: link });
    await actor.settled();
    expect(actor.state.name).toBe("linkMade");
    expect(expiresAt(actor)).toBe(VALID_FOR_MS["1d"]);
    expect(seen).toContain("endLinkFailed");
    expect(seen).not.toContain("linkEnded");
  });

  test("a failure with no link shown stays noLinkYet", async () => {
    const { actor } = setup(endingPort([], true));
    actor.send({ type: "endLink", payload: link });
    await actor.settled();
    expect(actor.state.name).toBe("noLinkYet");
  });

  test("no album is ignored, and so is endLink while the time saves", async () => {
    const ended: [string, number][] = [];
    const { actor } = setup(endingPort(ended));
    actor.send({ type: "endLink", payload: { ...link, folderId: "" } });
    actor.send({ type: "createLink", payload: { folderId: FOLDER, code: CODE } });
    actor.send({ type: "endLink", payload: link });
    await actor.settled();
    expect(ended).toEqual([]);
    expect(actor.state.name).toBe("linkMade");
  });
});

test("Ada makes a second link while the first works", async () => {
  const actor = make.create({ clock: VirtualClock() });
  actor.send({ type: "createLink", payload: { folderId: FOLDER, code: CODE } });
  await actor.settled();
  actor.send({ type: "chooseLinkTime", payload: { validFor: "7d" } });
  actor.send({ type: "makeNewLink", payload: { folderId: FOLDER, code: CODE } });
  await actor.settled();
  expect(expiresAt(actor)).toBe(VALID_FOR_MS["7d"]);
});

test("Ada ends one of her links", async () => {
  const actor = make.create({ clock: VirtualClock() });
  actor.send({ type: "createLink", payload: { folderId: FOLDER, code: CODE } });
  await actor.settled();
  actor.send({ type: "endLink", payload: { folderId: FOLDER, endsAt: 5000 } });
  await actor.settled();
  expect(actor.state.name).toBe("linkMade");
});

test("Ending a link fails and it stays", async () => {
  const actor = make.create({ clock: VirtualClock(), port: endingPort([], true) });
  actor.send({ type: "createLink", payload: { folderId: FOLDER, code: CODE } });
  await actor.settled();
  actor.send({ type: "endLink", payload: { folderId: FOLDER, endsAt: 5000 } });
  await actor.settled();
  expect(actor.state.name).toBe("linkMade");
});

const designPayloads = {
  chooseLinkTime: [{ validFor: "10m" }, { validFor: "1h" }, { validFor: "1d" }, { validFor: "7d" }],
  createLink: [{ folderId: FOLDER, code: CODE }],
  makeNewLink: [{ folderId: FOLDER, code: CODE }],
  endLink: [{ folderId: FOLDER, endsAt: 1000 }],
  turnOffLink: [{ folderId: FOLDER, code: CODE }],
  linkOff: [{ folderId: FOLDER, code: CODE }],
  linkOffFailed: [{ folderId: FOLDER }],
  oneLinkEnded: [{}],
  couldNotEndLink: [{}],
  linkReplaced: [{ folderId: FOLDER, code: CODE, name: "Ben" }],
};

describe("invite link design", () => {
  test("has no design errors", () => {
    expectNoDesignErrors({ machine: inviteLinkMachine, payloads: designPayloads });
  });
  test("reaches every state", () => {
    expectAllStatesReached({ machine: inviteLinkMachine, payloads: designPayloads });
  });
});

describe("linkKindOf", () => {
  test.each(Object.keys(VALID_FOR_MS) as ValidFor[])(
    "names %s from its span, also a second short",
    (kind) => {
      expect(linkKindOf({ madeAt: 5_000, endsAt: 5_000 + VALID_FOR_MS[kind] })).toBe(kind);
      expect(linkKindOf({ madeAt: 5_000, endsAt: 5_000 + VALID_FOR_MS[kind] - 999 })).toBe(kind);
    },
  );

  test("names nothing for a span that fits no kind", () => {
    expect(linkKindOf({ madeAt: 5_000, endsAt: 5_000 + 30 * 60_000 })).toBeUndefined();
    expect(linkKindOf({ madeAt: 5_000, endsAt: 5_000 })).toBeUndefined();
    expect(linkKindOf({ madeAt: 5_000, endsAt: 1_000 })).toBeUndefined();
  });
});

describe("more than one link, at the edges", () => {
  test("three links of the same time made in one second get three ends", async () => {
    const saved: [string, number][] = [];
    const { actor } = setup(savingPort(saved));
    for (let i = 0; i < 3; i++) {
      actor.send({ type: "makeNewLink", payload: { folderId: FOLDER, code: CODE } });
      await actor.settled();
    }
    expect(new Set(saved.map(([, at]) => at)).size).toBe(3);
  });

  test("a time picked while saving, then another link in that second, gets its own end", async () => {
    const saved: [string, number][] = [];
    const { actor } = setup(savingPort(saved));
    actor.send({ type: "createLink", payload: { folderId: FOLDER, code: CODE } });
    actor.send({ type: "chooseLinkTime", payload: { validFor: "7d" } });
    await actor.settled();
    actor.send({ type: "makeNewLink", payload: { folderId: FOLDER, code: CODE } });
    await actor.settled();
    expect(saved.map(([, at]) => at)).toEqual([
      VALID_FOR_MS["1d"],
      VALID_FOR_MS["7d"],
      VALID_FOR_MS["7d"] + 1000,
    ]);
  });

  test("while a link is shown, makeNewLink with no album or a turned-off code, and endLink with no album, do nothing", async () => {
    const OTHER = "e".repeat(64);
    const saved: [string, number][] = [];
    const ended: [string, number][] = [];
    const { actor } = setup({
      saveLinkTime: async (folderId, at) => {
        saved.push([folderId, at]);
        return [null, { ok: true }];
      },
      turnOff: async () => [null, { invite: { code: NEW_CODE } }],
      endLink: async (folderId, endsAt) => {
        ended.push([folderId, endsAt]);
        return [null, { ok: true }];
      },
    });
    actor.send({ type: "createLink", payload: { folderId: FOLDER, code: CODE } });
    await actor.settled();
    turnOff(actor, OTHER, NEW_CODE);
    await actor.settled();
    expect(actor.state.name).toBe("linkMade");
    actor.send({ type: "makeNewLink", payload: { folderId: OTHER, code: NEW_CODE } });
    await actor.settled();
    actor.send({ type: "makeNewLink", payload: { folderId: "", code: CODE } });
    await actor.settled();
    actor.send({ type: "endLink", payload: { folderId: "", endsAt: 5000 } });
    await actor.settled();
    expect(saved).toHaveLength(1);
    expect(ended).toEqual([]);
    expect(actor.state.name).toBe("linkMade");
  });
});
