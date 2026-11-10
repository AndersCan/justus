import { describe, expect, test } from "vite-plus/test";
import { INTRO_CARDS } from "./intro-cards";

describe("intro cards", () => {
  test("titles", () => {
    expect(INTRO_CARDS.map((c) => c.title)).toEqual([
      "Photos go straight to your friends",
      "You decide who joins",
    ]);
  });

  test("first card says photos go straight between phones", () => {
    const body = INTRO_CARDS[0]?.body as string;
    expect(body).toContain("straight from your phone");
    expect(body).toContain("Nobody else gets a copy");
  });

  test("second card promises no per-photo choice, which a Viewer does not get", () => {
    expect(INTRO_CARDS[1]?.body as string).not.toContain("photos you pick");
  });

  test("bodies are plain strings that avoid stale claims", () => {
    for (const card of INTRO_CARDS) {
      expect(typeof card.body).toBe("string");
      expect(card.body as string).not.toContain("Anyone with the link");
      expect(card.body as string).not.toContain("online");
    }
  });
});
