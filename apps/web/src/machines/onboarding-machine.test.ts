import { describe, expect, test, vi, beforeEach } from "vite-plus/test";
import { VirtualClock } from "@mantaq/core";
import { onOutput } from "@mantaq/sugar";
import {
  onboardingViewModel,
  INTRO_CARD_COUNT,
  createOnboardingActor,
  onboarding,
  onboardingActor,
} from "./onboarding-machine";
import { foldersActor } from "./folders-machine";
import { gateway } from "../gateway";

const mock = gateway as any;
const vm = (userName = "") => onboardingViewModel(onboardingActor.snapshot(), userName);
const userName = () => foldersActor.snapshot().context.userName;

vi.mock("../gateway", () => ({
  gateway: { setName: vi.fn(), logs: { view: vi.fn(), clear: vi.fn() } },
}));

beforeEach(() => {
  mock.setName.mockReset().mockResolvedValue([null, { name: "Maya" }]);
});

describe("onboarding machine", () => {
  test("steps through the intro cards, then reaches the profile", () => {
    expect(onboarding.state()).toBe("cards");
    onboarding.next();
    expect(vm().card).toBe(1);
    onboarding.back();
    expect(vm().card).toBe(0);
    for (let i = 0; i < INTRO_CARD_COUNT; i++) onboarding.next();
    expect(onboarding.state()).toBe("profile");
  });

  test("back from the profile returns to the last card", () => {
    onboarding.back();
    expect(onboarding.state()).toBe("cards");
    expect(vm().card).toBe(INTRO_CARD_COUNT - 1);
    onboarding.skip();
    expect(onboarding.state()).toBe("profile");
  });

  test("the profile field is not prefilled with the generated device name", () => {
    expect(vm("Quiet Otter").draftName).toBe("");
  });

  test("typing on the profile step updates the draft the preview reads", () => {
    expect(vm().draftName).toBe("");
    onboarding.editName("Maya Lin");
    expect(vm().draftName).toBe("Maya Lin");
    expect(onboarding.state()).toBe("profile");
  });

  test("a failed save stays on the profile with the error", async () => {
    mock.setName.mockResolvedValue([new Error("disk full"), null]);
    onboarding.saveProfile("Maya");
    await vi.waitFor(() => expect(onboarding.state()).toBe("profile"));
    expect(vm().error).toBe("disk full");
  });

  test("saving the profile stores the name and moves to the choice", async () => {
    onboarding.saveProfile("  Maya ");
    await vi.waitFor(() => expect(onboarding.state()).toBe("choose"));
    expect(mock.setName).toHaveBeenLastCalledWith("Maya");
    expect(userName()).toBe("Maya");
  });
});

describe("onboarding actor factory", () => {
  const send = (actor: { send(e: never): unknown }, type: string, payload?: unknown) =>
    actor.send({ type, payload } as never);

  function setup(setName = vi.fn().mockResolvedValue([null, { name: "Maya" }])) {
    const actor = createOnboardingActor({ clock: VirtualClock(), gateway: { setName } as any });
    const outputs: { type: string; payload?: any }[] = [];
    onOutput(actor, (e) => outputs.push(e as any));
    return { actor, setName, outputs };
  }

  test("six nexts reach the profile", () => {
    const { actor } = setup();
    for (let i = 0; i < INTRO_CARD_COUNT - 1; i++) send(actor, "NEXT");
    expect(actor.state.name).toBe("cards");
    expect(actor.snapshot().context.card).toBe(INTRO_CARD_COUNT - 1);
    send(actor, "NEXT");
    expect(actor.state.name).toBe("profile");
  });

  test("back on the first card stays put", () => {
    const { actor } = setup();
    send(actor, "BACK");
    expect(actor.state.name).toBe("cards");
    expect(actor.snapshot().context.card).toBe(0);
  });

  test("back from the profile returns to the last card", () => {
    const { actor } = setup();
    send(actor, "SKIP");
    send(actor, "BACK");
    expect(actor.state.name).toBe("cards");
    expect(actor.snapshot().context.card).toBe(INTRO_CARD_COUNT - 1);
  });

  test("typing updates the draft", () => {
    const { actor } = setup();
    send(actor, "SKIP");
    send(actor, "EDIT_NAME", { name: "Maya Lin" });
    expect(actor.snapshot().context.draftName).toBe("Maya Lin");
  });

  test("an empty name fails without calling the port", async () => {
    const { actor, setName } = setup();
    send(actor, "SKIP");
    send(actor, "SAVE_PROFILE", { name: "   " });
    await actor.settled();
    expect(actor.state.name).toBe("profile");
    expect(actor.snapshot().context.error).toBe("Enter a name to continue");
    expect(setName).not.toHaveBeenCalled();
  });

  test("a save failure stays on the profile with the error", async () => {
    const { actor } = setup(vi.fn().mockResolvedValue([new Error("disk full"), null]));
    send(actor, "SKIP");
    send(actor, "SAVE_PROFILE", { name: "Maya" });
    await actor.settled();
    expect(actor.state.name).toBe("profile");
    expect(actor.snapshot().context.error).toBe("disk full");
  });

  test("a save moves to choose and emits the saved name", async () => {
    const { actor, setName, outputs } = setup();
    send(actor, "SKIP");
    send(actor, "SAVE_PROFILE", { name: "  Maya " });
    await actor.settled();
    expect(setName).toHaveBeenCalledWith("Maya");
    expect(actor.state.name).toBe("choose");
    expect(outputs.map((o) => [o.type, o.payload])).toEqual([["NAME_SAVED", { name: "Maya" }]]);
  });

  test("a retry clears the earlier error", async () => {
    const setName = vi
      .fn()
      .mockResolvedValueOnce([new Error("disk full"), null])
      .mockResolvedValueOnce([null, { name: "Maya" }]);
    const { actor } = setup(setName);
    send(actor, "SKIP");
    send(actor, "SAVE_PROFILE", { name: "Maya" });
    await actor.settled();
    send(actor, "SAVE_PROFILE", { name: "Maya" });
    expect(actor.snapshot().context.error).toBeNull();
    await actor.settled();
    expect(actor.state.name).toBe("choose");
  });
});

describe("onboardingViewModel", () => {
  const build = () => createOnboardingActor({ clock: VirtualClock() });
  const send = (a: ReturnType<typeof build>, type: string, payload?: unknown) =>
    (a as any).send({ type, payload });

  test("initial snapshot takes the user name from the caller", () => {
    expect(onboardingViewModel(build().snapshot(), "Quiet Otter")).toEqual({
      card: 0,
      cardCount: INTRO_CARD_COUNT,
      state: "cards",
      saving: false,
      error: null,
      fatal: false,
      userName: "Quiet Otter",
      draftName: "",
    });
  });

  test("saving while the name is stored", () => {
    mock.setName.mockReturnValue(new Promise(() => {}));
    const actor = createOnboardingActor({ clock: VirtualClock(), gateway: mock } as any);
    send(actor, "SKIP");
    send(actor, "SAVE_PROFILE", { name: "Maya" });
    const vm = onboardingViewModel(actor.snapshot(), "");
    expect(vm.state).toBe("saving");
    expect(vm.saving).toBe(true);
  });
});
