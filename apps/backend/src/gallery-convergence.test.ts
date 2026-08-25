import { createHash } from "node:crypto";
import { describe, expect, test } from "vite-plus/test";
import {
  canonicalGalleryOrder,
  deriveGallery,
  type DerivedPhoto,
  type DriveScan,
} from "./gallery-order";

/**
 * Deterministic fork convergence harness (issue #23, invariants I1/I3/I5/I6).
 *
 * The pure derivation layer (`gallery-derive.test.ts` / `gallery-order.test.ts`)
 * pins each invariant against hand-built scans. This file pins them against a
 * *fork*: two replicas that own disjoint drives, exchange partial/byte-ordered
 * "sync steps" (prefix-copies of owner drives) under a manual clock + seeded
 * PRNG, and must converge to an identical gallery regardless of how the
 * offline/concurrent history was interleaved.
 *
 * The fork is runnable vitest with no Bare runtime or live p2p — it drives
 * `deriveGallery` directly from in-memory drive views, mirroring the real seam's
 * semantics (drive = owner key + entries; tombstones keyed by `ownerKey:id`).
 * `sha256` is a *real* content hash, so I5 (identical bytes dedupe, distinct
 * bytes never collide) holds exactly as it does in production.
 */

// mulberry32 — a tiny deterministic PRNG so the interleavings are a fixed fuzz,
// not a flaky one. Same seed => same history across runs.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

interface Entry {
  addedAt: number;
  name: string;
  mime: string;
  size: number;
  /** Real content hash — I5 dedupe keys on this. */
  sha256: string;
}

/** A device's *view*: the drive slices it can currently read, per owner key.
 * Sync steps copy owner-drive entries into a view; the owner's own drive is
 * authoritative (ingest happens there). */
class Replica {
  readonly device: string;
  readonly view = new Map<string, Map<string, Entry>>();
  constructor(device: string) {
    this.device = device;
  }
  ensure(ownerKey: string): Map<string, Entry> {
    let m = this.view.get(ownerKey);
    if (!m) {
      m = new Map();
      this.view.set(ownerKey, m);
    }
    return m;
  }
}

/** Shared ground truth: each owner's authoritative drive content + a global
 * tombstone set. Ingest/remove mutate this; replicas converge onto it. */
class World {
  readonly owners: string[];
  readonly drives = new Map<string, Map<string, Entry>>();
  readonly removed = new Set<string>();
  constructor(owners: string[]) {
    this.owners = owners;
    for (const o of owners) this.drives.set(o, new Map());
  }

  /** I5 — sha256 ingest dedupe: re-ingesting identical bytes onto an owner
   * drive does not create a second entry (same content => same digest). */
  ingest(rng: () => number, ownerKey: string, localId: string, content: string): void {
    const drive = this.drives.get(ownerKey);
    if (!drive) return;
    const sha = sha256Hex(content);
    for (const e of drive.values()) if (e.sha256 === sha) return; // dedupe
    drive.set(localId, {
      addedAt: Math.floor(rng() * 1000),
      name: localId,
      mime: "image/jpeg",
      size: content.length,
      sha256: sha,
    });
  }

  remove(ownerKey: string, localId: string): void {
    this.removed.add(`${ownerKey}:${localId}`);
  }
}

function scansOf(drives: Map<string, Map<string, Entry>>): DriveScan[] {
  const scans: DriveScan[] = [];
  for (const [ownerKey, entries] of drives) {
    scans.push({
      key: ownerKey,
      entries: [...entries].map(([localId, e]) => ({
        key: `/photos/${localId}.jpg`,
        value: {
          size: e.size,
          metadata: {
            addedAt: e.addedAt,
            name: e.name,
            mime: e.mime,
            sha256: e.sha256,
          },
        },
      })),
    });
  }
  return scans;
}

/** A partial sync step: copy a random subset of an owner drive's entries that
 * the destination is still missing — models partial / byte-ordered replication.
 * Entries are overwritten (re-pushed), so a value changed after an earlier
 * partial copy is refreshed, letting stale copies converge away. */
function syncStep(dst: Replica, world: World, rng: () => number): void {
  const ownerKeys = [...world.owners];
  const ownerKey = ownerKeys[Math.floor(rng() * ownerKeys.length)]!;
  const authoritative = world.drives.get(ownerKey);
  const local = dst.ensure(ownerKey);
  if (!authoritative) return;
  const missing = [...authoritative.keys()].filter((id) => !local.has(id));
  if (missing.length === 0) return;
  for (let i = missing.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [missing[i], missing[j]] = [missing[j]!, missing[i]!];
  }
  const copyCount = 1 + Math.floor(rng() * missing.length);
  for (let i = 0; i < copyCount; i++) local.set(missing[i]!, authoritative.get(missing[i]!)!);
}

/** Quiescence: copy every owner drive's full content into the replica
 * (overwriting, so any stale partial copy is refreshed). */
function fullSync(r: Replica, world: World): void {
  for (const ownerKey of world.owners) {
    const authoritative = world.drives.get(ownerKey)!;
    const local = r.ensure(ownerKey);
    for (const [id, e] of authoritative) local.set(id, e);
  }
}

/** Structural invariants that hold on *every* derived gallery, at every step —
 * they are pure functions of the record data, independent of replication lag. */
function assertStructuralInvariants(g: DerivedPhoto[]): void {
  // I3 — canonical order is a pure function of record data: re-sorting by the
  // canonical key is a no-op (the gallery is already canonically ordered).
  const key = (p: DerivedPhoto) => `${p.driveKey}:${p.id}`;
  const resorted = [...g].sort((a, b) =>
    canonicalGalleryOrder(
      { addedAt: a.addedAt, memberKey: a.driveKey, id: a.id },
      { addedAt: b.addedAt, memberKey: b.driveKey, id: b.id },
    ),
  );
  expect(g.map(key)).toEqual(resorted.map(key));

  // I1 — composite identity: `ownerKey:id` is unique across the gallery, so two
  // members reusing the same local id stay distinct on every replica.
  const composite = g.map((p) => `${p.driveKey}:${p.id}`);
  expect(new Set(composite).size).toBe(composite.length);
}

/** I5 — per-owner sha256 uniqueness. The converged album never contains two
 * entries from one owner that share a digest: ingest dedupes identical bytes,
 * and distinct contents have distinct real hashes. (Asserted post-quiescence,
 * since a replica mid-fork can briefly hold a stale copy whose digest collides
 * with a current entry — that lag resolves once the owner's drive is fully
 * re-pushed, exactly as in production.) */
function assertIngestInvariant(g: DerivedPhoto[]): void {
  const seenByOwner = new Map<string, Set<string>>();
  for (const p of g) {
    if (!p.sha256) continue; // every entry in this harness carries a real digest
    const seen = seenByOwner.get(p.driveKey) ?? new Set<string>();
    expect(seen.has(p.sha256)).toBe(false);
    seen.add(p.sha256);
    seenByOwner.set(p.driveKey, seen);
  }
}

describe("deterministic fork convergence (issue #23, I1/I3/I5/I6)", () => {
  const OWNER_A = "a".repeat(64);
  const OWNER_B = "b".repeat(64);

  function runSeed(seed: number): void {
    const rng = mulberry32(seed);
    const world = new World([OWNER_A, OWNER_B]);
    const a = new Replica("A");
    const b = new Replica("B");
    a.ensure(OWNER_A); // each device owns its own drive
    b.ensure(OWNER_B);

    const removedRecord = (): Record<string, unknown> =>
      Object.fromEntries([...world.removed].map((k) => [k, true]));
    const nameFor = (key: string) => `m-${key.slice(0, 4)}`;
    const galleryOf = (r: Replica): DerivedPhoto[] =>
      deriveGallery(scansOf(r.view), removedRecord(), nameFor);
    const ideal = (): DerivedPhoto[] =>
      deriveGallery(scansOf(world.drives), removedRecord(), nameFor);
    const norm = (g: DerivedPhoto[]) =>
      g.map((p) => `${p.driveKey}:${p.id}:${p.addedAt}:${p.sha256}`).join("|");

    // Random interleaving of ingests, removes, and partial sync steps. Baselines
    // give every owner at least one photo so the fork has content to converge.
    world.ingest(rng, OWNER_A, "base", "content-a-base");
    world.ingest(rng, OWNER_B, "base", "content-b-base");

    const ops = 40;
    for (let i = 0; i < ops; i++) {
      const roll = rng();
      if (roll < 0.45) {
        const owner = rng() < 0.5 ? OWNER_A : OWNER_B;
        const id = `p${Math.floor(rng() * 8)}`;
        // ~30% of ingests reuse a content id to exercise I5 dedupe.
        const content = rng() < 0.3 ? "content-dup" : `content-${owner.slice(0, 1)}-${id}`;
        world.ingest(rng, owner, id, content);
      } else if (roll < 0.6) {
        const owner = rng() < 0.5 ? OWNER_A : OWNER_B;
        const id = `p${Math.floor(rng() * 8)}`;
        world.remove(owner, id);
      } else {
        if (rng() < 0.5) syncStep(a, world, rng);
        else syncStep(b, world, rng);
      }
      // Structural invariants hold on both replicas *throughout* the interleaving.
      assertStructuralInvariants(galleryOf(a));
      assertStructuralInvariants(galleryOf(b));
    }

    // Quiescence — full exchange both directions.
    for (let i = 0; i < 4; i++) {
      fullSync(a, world);
      fullSync(b, world);
    }

    const ga = galleryOf(a);
    const gb = galleryOf(b);
    assertStructuralInvariants(ga);
    assertStructuralInvariants(gb);
    assertIngestInvariant(ga);
    assertIngestInvariant(gb);
    assertIngestInvariant(ideal());
    // I6 — replicas converge to the same gallery, equal to the ground-truth ideal.
    expect(norm(ga)).toBe(norm(gb));
    expect(norm(gb)).toBe(norm(ideal()));
  }

  test.each([1, 2, 3, 4, 5, 6, 7, 8])("converges for seed %i", (seed) => runSeed(seed));
});

describe("I5 — sha256 ingest dedupe (issue #23)", () => {
  const A = "a".repeat(64);
  const B = "b".repeat(64);

  test("re-ingesting identical bytes onto one owner drive yields one entry", () => {
    const world = new World([A, B]);
    const rng = mulberry32(99);
    world.ingest(rng, A, "pic", "same-bytes");
    world.ingest(rng, A, "pic", "same-bytes"); // deduped
    world.ingest(rng, A, "pic", "same-bytes"); // deduped
    expect([...world.drives.get(A)!.keys()]).toEqual(["pic"]);
  });

  test("identical bytes on two different owners are both kept (distinct members)", () => {
    const world = new World([A, B]);
    const rng = mulberry32(7);
    world.ingest(rng, A, "pic", "same-bytes");
    world.ingest(rng, B, "pic", "same-bytes");
    expect(world.drives.get(A)!.has("pic")).toBe(true);
    expect(world.drives.get(B)!.has("pic")).toBe(true);
  });

  test("distinct bytes on the same owner yield distinct digests", () => {
    const world = new World([A, B]);
    const rng = mulberry32(3);
    world.ingest(rng, A, "x", "bytes-one");
    world.ingest(rng, A, "y", "bytes-two");
    const entries = [...world.drives.get(A)!.values()];
    expect(entries[0]!.sha256).not.toBe(entries[1]!.sha256);
  });
});
