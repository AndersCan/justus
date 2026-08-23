import { describe, expect, test } from "vite-plus/test";
import { deriveGallery, type DriveScan } from "./gallery-order";

const NAME = () => "device";

function entry(
  id: string,
  meta: Record<string, unknown> = {},
): {
  key: string;
  value: Record<string, unknown>;
} {
  return {
    key: `photos/${id}.jpg`,
    value: { size: 1, metadata: { addedAt: 0, name: id, mime: "image/jpeg", ...meta } },
  };
}

function scan(key: string, ids: Array<[string, Record<string, unknown>?]>): DriveScan {
  return { key, entries: ids.map(([id, meta]) => entry(id, meta)) };
}

describe("deriveGallery invariants (issue #23)", () => {
  const kA = "a".repeat(64);
  const kB = "b".repeat(64);

  test("I1 — composite identity: same local id on two drives stays distinct", () => {
    const out = deriveGallery([scan(kA, [["x"]]), scan(kB, [["x"]])], {}, NAME);
    expect(out.map((p) => `${p.driveKey.slice(0, 4)}:${p.id}`).sort()).toEqual([
      "aaaa:x",
      "bbbb:x",
    ]);
  });

  test("I2 — tombstone hides regardless of scan order or batching", () => {
    const scans = [scan(kA, [["p1"], ["p2"]]), scan(kB, [["p3"]])];
    const removed = { [`${kA}:p1`]: true };
    const direct = deriveGallery(scans, removed, NAME).map((p) => p.id);
    // Same tombstone set, different batch grouping (associative).
    const batched = deriveGallery(
      [scan(kA, [["p1"]]), scan(kA, [["p2"]]), scan(kB, [["p3"]])],
      removed,
      NAME,
    ).map((p) => p.id);
    expect(direct).toEqual(["p2", "p3"]);
    expect(batched).toEqual(direct);
    // Tombstone for an unseen id is inert.
    expect(deriveGallery(scans, { [`${kB}:ghost`]: true }, NAME).map((p) => p.id)).toEqual([
      "p1",
      "p2",
      "p3",
    ]);
  });

  test("I4 — sticky at derivation level: a re-added tombstoned id stays hidden", () => {
    const scans = [scan(kA, [["gone"], ["fresh"]])];
    const removed = { [`${kA}:gone`]: true };
    expect(deriveGallery(scans, removed, NAME).map((p) => p.id)).toEqual(["fresh"]);
    // The member re-adds the same local id while the tombstone stands.
    scans[0]!.entries.push(entry("gone"));
    expect(deriveGallery(scans, removed, NAME).map((p) => p.id)).toEqual(["fresh"]);
  });

  test("I6 — commutative over scan order; idempotent under duplicate scans", () => {
    const s1 = scan(kA, [["p1"]]);
    const s2 = scan(kB, [["p2"]]);
    const s3 = scan("c".repeat(64), [["p3"]]);
    const key = (out: ReturnType<typeof deriveGallery>) =>
      out.map((p) => `${p.driveKey.slice(0, 2)}:${p.id}`).join(",");
    expect(key(deriveGallery([s1, s2, s3], {}, NAME))).toBe(
      key(deriveGallery([s3, s1, s2], {}, NAME)),
    );
    expect(key(deriveGallery([s2, s3, s1], {}, NAME))).toBe(
      key(deriveGallery([s1, s2, s3], {}, NAME)),
    );
    // Duplicate scan of the same drive adds nothing.
    expect(key(deriveGallery([s1, s2, s1], {}, NAME))).toBe(key(deriveGallery([s1, s2], {}, NAME)));
  });

  test("metadata fallbacks: missing addedAt → 0, name → basename, sha256 passthrough", () => {
    const raw = {
      key: "photos/legacy",
      value: { size: 5, metadata: { sha256: "abc" } },
    };
    const out = deriveGallery([{ key: kA, entries: [raw as never] }], {}, NAME);
    expect(out[0]).toMatchObject({
      id: "legacy",
      ext: "",
      name: "legacy",
      addedAt: 0,
      size: 5,
      sha256: "abc",
      memberName: "device",
    });
  });

  test("mime fallback mirrors the host table, case-insensitively", () => {
    const raw = (id: string): { key: string; value: Record<string, unknown> } => ({
      key: `photos/${id}`,
      value: { size: 1, metadata: {} },
    });
    const out = deriveGallery(
      [
        {
          key: kA,
          entries: [raw("v.MP4"), raw("h.Heic"), raw("m.mov"), raw("u.PNG")],
        },
      ],
      {},
      NAME,
    );
    expect(Object.fromEntries(out.map((p) => [p.id, p.mime]))).toEqual({
      h: "image/heic",
      m: "video/quicktime",
      u: "image/png",
      v: "video/mp4",
    });
  });
});
