import { describe, expect, it } from "vite-plus/test";
import { newPhotosFrom } from "./new-photos-from";

const by = (key: string, name: string, n: number) =>
  Array.from({ length: n }, () => ({ member: { key, name } }));

describe("newPhotosFrom", () => {
  it("is null with nothing new", () => {
    expect(newPhotosFrom([])).toBeNull();
  });
  it("names the one person who added them", () => {
    expect(newPhotosFrom(by("a", "Ada", 36))).toEqual({ count: 36, adder: "Ada" });
    expect(newPhotosFrom(by("a", "Ada", 1))).toEqual({ count: 1, adder: "Ada" });
  });
  it("names nobody when two people added them", () => {
    expect(newPhotosFrom([...by("a", "Ada", 2), ...by("c", "Cara", 1)])).toEqual({ count: 3 });
  });
  it("names nobody when the adder has no name yet", () => {
    for (const name of ["Unknown device", "New member", "", "  "]) {
      expect(newPhotosFrom(by("a", name, 2))).toEqual({ count: 2 });
    }
  });
});
