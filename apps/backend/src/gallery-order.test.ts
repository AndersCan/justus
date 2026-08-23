import { describe, expect, test } from "vite-plus/test";
import { canonicalGalleryOrder, compareGalleryOrder, deriveGallery } from "./gallery-order";
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

/**
 * I3 — production path (bug #55): deriveGallery must produce output ordered
 * by the same canonical key the I3 spec certifies (compareGalleryOrder), not a
 * divergent one. The derived tie-break key (driveKey) and the raw Photo tie-
 * break key (member.key) must reduce to one source of truth.
 */

/**
 * I3 — production path (bug #55): deriveGallery must produce output ordered
 * by the same canonical key the I3 spec certifies (compareGalleryOrder), not a
 * divergent one. The derived tie-break key (driveKey) and the raw Photo tie-
 * break key (member.key) must reduce to one source of truth.
 */
describe("deriveGallery canonical order matches I3 spec (issue #55)", () => {
  const kA = "a".repeat(64);
  const kB = "b".repeat(64);
  const NAME = () => "device";

  function ds(
    key: string,
    ids: Array<[string, number]>,
  ): {
    key: string;
    entries: Array<{ key: string; value: Record<string, unknown> }>;
  } {
    return {
      key,
      entries: ids.map(([id, addedAt]) => ({
        key: `photos/${id}.jpg`,
        value: { size: 1, metadata: { addedAt, name: id, mime: "image/jpeg" } },
      })),
    };
  }

  test("deriveGallery output is already canonically ordered", () => {
    const derived = deriveGallery(
      [
        ds(kA, [
          ["p1", 300],
          ["p2", 300],
        ]),
        ds(kB, [["p3", 100]]),
      ],
      {},
      NAME,
    );
    const idOf = (p: { driveKey: string; id: string }) => `${p.driveKey}:${p.id}`;
    const sortedAgain = [...derived].sort((a, b) =>
      canonicalGalleryOrder(
        { addedAt: a.addedAt, memberKey: a.driveKey, id: a.id },
        { addedAt: b.addedAt, memberKey: b.driveKey, id: b.id },
      ),
    );
    expect(derived.map(idOf)).toEqual(sortedAgain.map(idOf));
  });

  test("served order matches compareGalleryOrder when Photos carry member.key = driveKey", () => {
    const derived = deriveGallery(
      [
        ds(kA, [["p1", 300]]),
        ds(kB, [
          ["q1", 300],
          ["q2", 200],
        ]),
      ],
      {},
      NAME,
    );
    const asPhotos: Photo[] = derived.map((d) => ({
      id: d.id,
      url: `http://x/${d.id}`,
      name: d.name,
      mime: d.mime,
      size: d.size,
      addedAt: d.addedAt,
      member: { key: d.driveKey, name: d.memberName },
    }));
    const reSorted = [...asPhotos].sort(compareGalleryOrder);
    const keyOf = (p: Photo) => `${p.member.key}:${p.id}`;
    expect(asPhotos.map(keyOf)).toEqual(reSorted.map(keyOf));
  });
});
