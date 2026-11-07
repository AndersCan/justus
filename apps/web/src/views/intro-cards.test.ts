import { describe, expect, test } from "vite-plus/test";
import { INTRO_CARDS } from "./intro-cards";

describe("intro cards", () => {
  test("titles", () => {
    expect(INTRO_CARDS.map((c) => c.title)).toEqual([
      "Welcome",
      "No servers, no accounts",
      "You decide who joins",
    ]);
  });

  test("bodies are plain strings that avoid stale claims", () => {
    for (const card of INTRO_CARDS) {
      expect(typeof card.body).toBe("string");
      expect(card.body as string).not.toContain("Anyone with the link");
      expect(card.body as string).not.toContain("online");
    }
  });
});
