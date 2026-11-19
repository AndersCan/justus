import { describe, expect, it } from "vite-plus/test";
import type { SyncStatus } from "@justus/core";
import { dotMembers, showsAdderDots, tileAdder } from "./adder-dot";

const by = (key: string) => ({ member: { key, name: key } });

describe("showsAdderDots", () => {
  it("needs two different adders", () => {
    expect(showsAdderDots([])).toBe(false);
    expect(showsAdderDots([by("ka"), by("ka"), by("ka")])).toBe(false);
    expect(showsAdderDots([by("ka"), by("kc")])).toBe(true);
  });
});

describe("tileAdder", () => {
  const cy = { member: { key: "kc", name: "  Cy " } };
  it("reads the seat and the trimmed name", () => {
    expect(tileAdder(cy, [{ key: "kc", color: 1 }])).toEqual({ color: 1, name: "Cy" });
  });
  it("has no colour for a member without a seat or one not listed", () => {
    expect(tileAdder(cy, [{ key: "kc" }]).color).toBeUndefined();
    expect(tileAdder(cy, [{ key: "ka", color: 2 }]).color).toBeUndefined();
  });
});

describe("dotMembers", () => {
  const status = { folder: { id: "f1" }, members: [{ key: "ka" }] } as unknown as SyncStatus;
  it("gives the open album's members, nothing elsewhere", () => {
    expect(dotMembers({ kind: "album", id: "f1" }, status)).toBe(status.members);
    expect(dotMembers({ kind: "all" }, status)).toBeUndefined();
    expect(dotMembers({ kind: "mine" }, status)).toBeUndefined();
    expect(dotMembers({ kind: "album", id: "f2" }, status)).toBeUndefined();
    expect(dotMembers({ kind: "album", id: "f1" }, null)).toBeUndefined();
  });
});
