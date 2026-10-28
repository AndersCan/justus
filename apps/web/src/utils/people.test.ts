import { describe, it, expect } from "vite-plus/test";
import type { JoinRequest, SyncStatus } from "@justus/core";
import { buildPeople, presenceLabel } from "./people";

const NOW = 1_000_000_000;

const status = (role: "creator" | "member", over: Partial<SyncStatus> = {}): SyncStatus =>
  ({
    folder: { id: "f1", role },
    members: [
      { key: "me", name: "Nils", admin: role === "creator", connected: true },
      {
        key: "a",
        name: "Maya",
        admin: role !== "creator",
        connected: false,
        lastSeenAt: NOW - 7_200_000,
      },
      { key: "b", name: "Alex", admin: false, connected: true },
    ],
    ...over,
  }) as SyncStatus;

const request = (folderId: string): JoinRequest => ({
  requesterKey: "k",
  requesterName: "Sam",
  folderId,
  folderName: "Trip",
  shareKey: "s",
  requestedAt: 0,
});

describe("buildPeople", () => {
  it("counts connected members and writes the chip text", () => {
    const p = buildPeople(status("member"), [], NOW);
    expect(p.chip).toBe("1 of 2 connected");
    expect(p.connectedCount).toBe(2);
  });

  it("lists you first, then the Admin, with presence wording", () => {
    const p = buildPeople(status("member"), [], NOW);
    expect(p.people.map((x) => x.name)).toEqual(["Nils", "Maya", "Alex"]);
    expect(p.people[0].presence).toBe("you");
    expect(p.people[1].presence).toBe("last seen 2 hr ago");
    expect(p.people[2].presence).toBe("connected");
  });

  it("shows pending requests for this album to the Admin only", () => {
    const reqs = [request("f1"), request("other")];
    expect(buildPeople(status("creator"), reqs, NOW).requests).toHaveLength(1);
    expect(buildPeople(status("member"), reqs, NOW).requests).toHaveLength(0);
  });

  it("handles no status", () => {
    expect(buildPeople(null, [], NOW).chip).toBe("Just you");
  });
});

describe("presenceLabel", () => {
  it("never says online", () => {
    expect(presenceLabel({ connected: true })).toBe("connected");
    expect(presenceLabel({ connected: false })).toBe("not seen yet");
  });
});
