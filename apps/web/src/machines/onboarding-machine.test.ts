import { describe, expect, test, vi, beforeEach } from "vite-plus/test";
import {
  $introCard,
  $onboardingError,
  $onboardingState,
  INTRO_CARD_COUNT,
  onboarding,
} from "./onboarding-machine";
import { $userName } from "./folders-machine";
import { gateway } from "../gateway";

const mock = gateway as any;

vi.mock("../gateway", () => ({
  gateway: { setName: vi.fn(), logs: { view: vi.fn(), clear: vi.fn() } },
}));

beforeEach(() => {
  mock.setName.mockReset().mockResolvedValue([null, { name: "Maya" }]);
  $userName.set("");
});

describe("onboarding machine", () => {
  test("steps through the intro cards, then reaches the profile", () => {
    expect($onboardingState.get()).toBe("cards");
    onboarding.next();
    expect($introCard.get()).toBe(1);
    onboarding.back();
    expect($introCard.get()).toBe(0);
    for (let i = 0; i < INTRO_CARD_COUNT; i++) onboarding.next();
    expect($onboardingState.get()).toBe("profile");
  });

  test("back from the profile returns to the last card", () => {
    onboarding.back();
    expect($onboardingState.get()).toBe("cards");
    expect($introCard.get()).toBe(INTRO_CARD_COUNT - 1);
    onboarding.skip();
    expect($onboardingState.get()).toBe("profile");
  });

  test("a failed save stays on the profile with the error", async () => {
    mock.setName.mockResolvedValue([new Error("disk full"), null]);
    onboarding.saveProfile("Maya");
    await vi.waitFor(() => expect($onboardingState.get()).toBe("profile"));
    expect($onboardingError.get()).toBe("disk full");
  });

  test("saving the profile stores the name and moves to the choice", async () => {
    onboarding.saveProfile("  Maya ");
    await vi.waitFor(() => expect($onboardingState.get()).toBe("choose"));
    expect(mock.setName).toHaveBeenLastCalledWith("Maya");
    expect($userName.get()).toBe("Maya");
  });
});
