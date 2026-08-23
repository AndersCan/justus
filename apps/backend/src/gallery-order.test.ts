import { describe, expect, test } from "vite-plus/test";
import { compareGalleryOrder } from "./gallery-order";
import type { Photo } from "@justus/core";

function photo(id: string, addedAt: number, memberKey: string): Photo {
  return {
    id,
    url: `http://x/${id}`,
    name: `${id}.jpg`,
    mime: "image/jpeg",
    size: 1,
    addedAt,
    member: { key: memberKey, name: memberKey },
  };
}

/** I3 canonical order: (addedAt desc, memberKey asc, id asc). */
describe("compareGalleryOrder (invariant I3)", () => {
  test("primary key: addedAt descending", () => {
    const a = photo("a", 100, "k1");
    const b = photo("b", 200, "k1");
    expect(compareGalleryOrder(b, a)).toBeLessThan(0);
    expect(compareGalleryOrder(a, b)).toBeGreaterThan(0);
  });

  test("tie on addedAt: memberKey ascending", () => {
    const a = photo("a", 100, "k2");
    const b = photo("b", 100, "k1");
    // k1 sorts before k2 despite arriving "after" in the array.
    expect(compareGalleryOrder(a, b)).toBeGreaterThan(0);
    expect(compareGalleryOrder(b, a)).toBeLessThan(0);
  });

  test("tie on addedAt+member: id ascending", () => {
    const a = photo("b", 100, "k1");
    const b = photo("a", 100, "k1");
    expect(compareGalleryOrder(a, b)).toBeGreaterThan(0);
    expect(compareGalleryOrder(b, a)).toBeLessThan(0);
  });

  test("identical records compare equal (commutative, antisymmetric)", () => {
    const a = photo("a", 100, "k1");
    const b = photo("a", 100, "k1");
    expect(compareGalleryOrder(a, b)).toBe(0);
    expect(compareGalleryOrder(b, a)).toBe(0);
  });

  test("sort is a pure function of record data — replica-order independent", () => {
    // The same entry set, received by two replicas in different orders.
    const entries: Array<[string, number, string]> = [
      ["p1", 300, "kB"],
      ["p2", 100, "kA"],
      ["p3", 300, "kA"],
      ["p4", 200, "kC"],
      ["p5", 300, "kB"],
      ["p6", 100, "kB"],
    ];
    const sort = (order: number[]) =>
      order
        .map((i) => photo(...entries[i]!))
        .sort(compareGalleryOrder)
        .map((p) => p.id);

    expect(sort([0, 1, 2, 3, 4, 5])).toEqual(sort([5, 2, 0, 4, 3, 1]));
    // Canonical expectation for this set:
    // 300: kA/p3, then kB/p1+p5 (id asc); 200: kC/p4; 100: kA/p2, kB/p6.
    expect(sort([0, 1, 2, 3, 4, 5])).toEqual(["p3", "p1", "p5", "p4", "p2", "p6"]);
  });
});
