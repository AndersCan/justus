import { describe, it, expect } from "vite-plus/test";
import type { SyncStatus } from "@justus/core";
import { reachHintText, unreachableMember } from "./reach-hint";

const status = (members: Array<Partial<SyncStatus["members"][number]>>): SyncStatus =>
  ({
    members: members.map((m, i) => ({
      key: `k${i}`,
      name: `M${i}`,
      admin: false,
      connected: false,
      ...m,
    })),
  }) as SyncStatus;

describe("unreachableMember", () => {
  it("is null when alone or when anyone else is connected", () => {
    expect(unreachableMember(null)).toBeNull();
    expect(unreachableMember(status([{ connected: true }]))).toBeNull();
    expect(unreachableMember(status([{ connected: true }, {}, { connected: true }]))).toBeNull();
  });

  it("names the Admin first when nobody else is connected", () => {
    const s = status([{ connected: true }, { name: "Alex" }, { name: "Maya", admin: true }]);
    expect(unreachableMember(s)).toBe("Maya");
  });

  it("falls back to the first member, or no name when it is unknown", () => {
    expect(unreachableMember(status([{ connected: true }, { name: "Alex" }]))).toBe("Alex");
    expect(unreachableMember(status([{ connected: true }, { name: "Unknown device" }]))).toBe("");
  });
});

describe("reachHintText", () => {
  it("suggests WiFi", () => {
    expect(reachHintText("Maya")).toBe(
      "Can't reach Maya. If you're both on mobile data, ask one of you to switch to WiFi.",
    );
    expect(reachHintText("")).toMatch(/^Can't reach anyone in this album yet\./);
  });
});
