import { describe, expect, it } from "vite-plus/test";
import { newPhotosFrom } from "./new-photos-from";

const by = (key: string, name: string, n: number) =>
  Array.from({ length: n }, () => ({ member: { key, name } }));

describe("newPhotosFrom", () => {
  it("is null with nothing new", () => {
    expect(newPhotosFrom([])).toBeNull();
  });
  it("names the one person who added them", () => {
    expect(newPhotosFrom(by("a", " Ada ", 3))).toEqual({
      count: 3,
      named: [{ key: "a", name: "Ada", count: 3 }],
    });
  });
  it("names two people, most photos first", () => {
    expect(newPhotosFrom([...by("c", "Cy", 2), ...by("a", "Ada", 3)])).toEqual({
      count: 5,
      named: [
        { key: "a", name: "Ada", count: 3 },
        { key: "c", name: "Cy", count: 2 },
      ],
    });
  });
  it("names nobody when no adder has a name yet", () => {
    for (const name of ["Unknown device", "New member", "", "  "]) {
      expect(newPhotosFrom(by("a", name, 2))).toEqual({ count: 2, named: [] });
    }
  });
  it("counts unnamed and past-three adders as more", () => {
    expect(
      newPhotosFrom([
        ...by("a", "Ada", 4),
        ...by("b", "Ben", 3),
        ...by("c", "Cy", 2),
        ...by("d", "Di", 1),
        ...by("e", "New member", 5),
      ]),
    ).toEqual({
      count: 15,
      named: [
        { key: "a", name: "Ada", count: 4 },
        { key: "b", name: "Ben", count: 3 },
        { key: "c", name: "Cy", count: 2 },
      ],
      more: 6,
    });
  });
  it("orders a tie by key, not by which photo came first", () => {
    expect(newPhotosFrom([...by("c", "Cy", 1), ...by("a", "Ada", 1)])?.named).toEqual([
      { key: "a", name: "Ada", count: 1 },
      { key: "c", name: "Cy", count: 1 },
    ]);
  });

  it("keeps two people who share a name apart", () => {
    expect(newPhotosFrom([...by("a", "Ada", 1), ...by("b", "Ada", 1)])?.named).toHaveLength(2);
  });
});
