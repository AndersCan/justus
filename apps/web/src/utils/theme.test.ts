import { describe, expect, it } from "vite-plus/test";
import { readTheme, writeTheme } from "./theme";

describe("theme", () => {
  it("falls back to system without storage (node)", () => {
    expect(readTheme()).toBe("system");
    expect(() => writeTheme("dark")).not.toThrow();
  });
});
