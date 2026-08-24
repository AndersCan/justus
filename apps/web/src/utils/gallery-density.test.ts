import { describe, expect, test } from "vite-plus/test";
import { gridColsFor } from "./gallery-density";

describe("gridColsFor", () => {
  test("comfortable is the default, roomier grid", () => {
    expect(gridColsFor("comfortable")).toBe(
      "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5",
    );
  });

  test("compact packs more columns per breakpoint", () => {
    expect(gridColsFor("compact")).toBe("grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-7");
  });

  test("both densities cover every breakpoint and are distinct", () => {
    const a = gridColsFor("comfortable").split(" ");
    const b = gridColsFor("compact").split(" ");
    expect(a.length).toBe(b.length);
    // No class is shared between the two densities.
    expect(new Set([...a, ...b]).size).toBe(a.length + b.length);
  });
});
