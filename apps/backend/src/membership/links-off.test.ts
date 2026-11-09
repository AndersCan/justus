import { describe, it, expect } from "vite-plus/test";
import { linksOffFile, linksOffIn } from "./invites";

describe("links-off file", () => {
  it("round-trips ids, sorted", () => {
    expect(linksOffIn(linksOffFile(["b", "a"]))).toEqual(["a", "b"]);
  });

  it("reads nothing from a missing, garbled or odd file", () => {
    expect(linksOffIn(null)).toEqual([]);
    expect(linksOffIn("{")).toEqual([]);
    expect(linksOffIn("null")).toEqual([]);
    expect(linksOffIn('{"off":"x"}')).toEqual([]);
    expect(linksOffIn('{"off":["a",1,null]}')).toEqual(["a"]);
  });
});
