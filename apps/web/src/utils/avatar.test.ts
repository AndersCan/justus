import { describe, it, expect } from "vite-plus/test";
import { avatarColor, hueOf, initialsOf } from "./avatar";

describe("avatar", () => {
  it("takes initials from the first two words", () => {
    expect(initialsOf("maya lindqvist")).toBe("ML");
    expect(initialsOf("  Nils  ")).toBe("NI");
    expect(initialsOf("a b c")).toBe("AB");
  });

  it("falls back to ? for an empty name", () => {
    expect(initialsOf("   ")).toBe("?");
  });

  it("derives a stable colour from the name, ignoring case and padding", () => {
    expect(hueOf("Maya")).toBe(hueOf(" maya "));
    expect(hueOf("Maya")).toBeGreaterThanOrEqual(0);
    expect(hueOf("Maya")).toBeLessThan(360);
    expect(avatarColor("Maya")).toBe(avatarColor("MAYA"));
  });
});
