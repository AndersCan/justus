import { describe, expect, it } from "vite-plus/test";
import {
  ADMIN_COLOR,
  fillColors,
  parseColor,
  pickColor,
  takenColors,
} from "../../src/membership/colors.ts";
import type { RegistryFile, ViewersFile } from "../../src/membership/records.ts";
import { parseRegistry, parseViewers } from "../../src/membership/records.ts";
import { makeMemberViewer, makeViewerMember } from "../../src/membership/viewers.ts";
import type { Drive } from "../../src/ports/drive-store.ts";

const K = (c: string) => c.repeat(64);

describe("pickColor", () => {
  it("takes the lowest free seat from 1", () => {
    expect(pickColor(new Set([0]))).toBe(1);
    expect(pickColor(new Set([0, 1, 3]))).toBe(2);
  });
  it("takes the preferred seat when it is free", () => {
    expect(pickColor(new Set([0, 1]), 3)).toBe(3);
  });
  it("ignores the preferred seat when it is taken", () => {
    expect(pickColor(new Set([0, 1, 3]), 3)).toBe(2);
  });
});

describe("parseColor", () => {
  it("accepts 1 and 999", () => {
    expect([parseColor(1), parseColor(999)]).toEqual([1, 999]);
  });
  it("reads anything else as absent", () => {
    for (const bad of [0, -1, 1.5, "2", 1000, null, undefined, NaN]) {
      expect(parseColor(bad)).toBeUndefined();
    }
  });
});

const registry = (): RegistryFile => ({
  version: 1,
  members: {
    [K("a")]: { key: K("a"), name: "A", addedAt: 5 },
    [K("b")]: { key: K("b"), name: "B", addedAt: 2, color: 1 },
    [K("c")]: { key: K("c"), name: "C", addedAt: 2 },
  },
});
const viewers = (): ViewersFile => ({
  version: 1,
  viewers: { [K("d")]: { key: K("d"), name: "D", addedAt: 1 } },
});

describe("takenColors", () => {
  it("holds the Admin seat and every seat in both lists", () => {
    const v = viewers();
    v.viewers[K("d")]!.color = 4;
    expect([...takenColors(registry(), v.viewers)].sort()).toEqual([0, 1, 4]);
  });
});

describe("fillColors", () => {
  it("fills oldest first, members before viewers, ties by key", () => {
    const out = fillColors(registry(), viewers());
    expect(out.registry.members[K("b")]!.color).toBe(1);
    expect(out.registry.members[K("c")]!.color).toBe(2);
    expect(out.registry.members[K("a")]!.color).toBe(3);
    expect(out.viewers.viewers[K("d")]!.color).toBe(4);
    expect([out.membersChanged, out.viewersChanged]).toEqual([true, true]);
  });
  it("changes nothing the second time", () => {
    const first = fillColors(registry(), viewers());
    const second = fillColors(first.registry, first.viewers);
    expect([second.membersChanged, second.viewersChanged]).toEqual([false, false]);
    expect(second.registry).toEqual(first.registry);
  });
  it("reports only the file it changed", () => {
    const out = fillColors({ version: 1, members: {} }, viewers());
    expect([out.membersChanged, out.viewersChanged]).toEqual([false, true]);
  });
  it("keeps the Admin seat out of reach", () => {
    expect(ADMIN_COLOR).toBe(0);
    const out = fillColors(registry(), viewers());
    const seats = [
      ...["a", "b", "c"].map((c) => out.registry.members[K(c)]?.color),
      out.viewers.viewers[K("d")]?.color,
    ];
    expect(seats.every((c) => c !== undefined && c >= 1)).toBe(true);
  });
});

describe("parsing keeps a valid colour and drops an invalid one", () => {
  it("registry", () => {
    const text = JSON.stringify({
      version: 1,
      members: {
        [K("a")]: { key: K("a"), name: "A", addedAt: 1, color: 2 },
        [K("b")]: { key: K("b"), name: "B", addedAt: 1, color: 1.5 },
        [K("c")]: { key: K("c"), name: "C", addedAt: 1 },
      },
    });
    const members = parseRegistry(text).members;
    expect(members[K("a")]).toEqual({ key: K("a"), name: "A", addedAt: 1, color: 2 });
    expect(members[K("b")]).toEqual({ key: K("b"), name: "B", addedAt: 1 });
    expect(members[K("c")]).toEqual({ key: K("c"), name: "C", addedAt: 1 });
  });
  it("viewers", () => {
    const text = JSON.stringify({
      version: 1,
      viewers: {
        [K("a")]: { key: K("a"), name: "A", addedAt: 1, color: 3 },
        [K("b")]: { key: K("b"), name: "B", addedAt: 1, color: 1000 },
      },
    });
    const parsed = parseViewers(text).viewers;
    expect(parsed[K("a")]?.color).toBe(3);
    expect("color" in parsed[K("b")]!).toBe(false);
  });
});

describe("a role change keeps the colour", () => {
  const drive = { async put() {} } as unknown as Drive;
  it("Viewer to Collaborator", async () => {
    const [, out] = await makeViewerMember(drive, {
      viewers: {
        version: 1,
        viewers: { [K("a")]: { key: K("a"), name: "A", addedAt: 1, color: 3 } },
      },
      registry: { version: 1, members: {} },
      memberKey: K("a"),
    });
    expect(out?.registry.members[K("a")]?.color).toBe(3);
  });
  it("Collaborator to Viewer", async () => {
    const [, out] = await makeMemberViewer(drive, {
      viewers: { version: 1, viewers: {} },
      registry: {
        version: 1,
        members: { [K("a")]: { key: K("a"), name: "A", addedAt: 1, color: 2 } },
      },
      memberKey: K("a"),
      keptVersion: 1,
    });
    expect(out?.viewers.viewers[K("a")]?.color).toBe(2);
  });
  it("leaves no colour key when the person had none", async () => {
    const [, out] = await makeViewerMember(drive, {
      viewers: { version: 1, viewers: { [K("a")]: { key: K("a"), name: "A", addedAt: 1 } } },
      registry: { version: 1, members: {} },
      memberKey: K("a"),
    });
    expect("color" in out!.registry.members[K("a")]!).toBe(false);
  });
});
