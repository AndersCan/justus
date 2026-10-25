import { describe, expect, it } from "vite-plus/test";
import { nextTheme, readTheme, writeTheme } from "./theme";

describe("theme", () => {
  it("cycles system → light → dark → system", () => {
    expect(nextTheme("system")).toBe("light");
    expect(nextTheme("light")).toBe("dark");
    expect(nextTheme("dark")).toBe("system");
  });

  it("falls back to system without storage (node)", () => {
    expect(readTheme()).toBe("system");
    expect(() => writeTheme("dark")).not.toThrow();
  });
});
