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

describe("buildPeople viewers", () => {
  it("a viewer gets a presence line like anyone else", () => {
    const s = {
      folder: { id: "f1", role: "creator" },
      members: [
        { key: "me", name: "Maya", admin: true, connected: true },
        { key: "v", name: "Nils", admin: false, connected: true, viewer: true },
        {
          key: "w",
          name: "Vera",
          admin: false,
          connected: false,
          viewer: true,
          lastSeenAt: NOW - 120_000,
        },
        { key: "c", name: "Ana", admin: false, connected: false },
      ],
    } as SyncStatus;
    const [, nils, vera, ana] = buildPeople(s, [], {}, NOW).people;
    expect(nils.viewer).toBe(true);
    expect(nils.presence).toBe("connected");
    expect(vera.viewer).toBe(true);
    expect(vera.presence).toMatch(/^last seen/);
    expect(ana.viewer).toBe(false);
    expect(ana.presence).toBe("not seen yet");
  });
});

describe("buildPeople friends", () => {
  const withIdentity = (): SyncStatus =>
    ({
      folder: { id: "f1", role: "member" },
      members: [
        { key: "me", name: "Nils", admin: false, connected: true, identity: "i-me" },
        { key: "a", name: "Maya", admin: true, connected: true, identity: "i-maya" },
        { key: "b", name: "Alex", admin: false, connected: true },
      ],
    }) as SyncStatus;

  it("shows the friend name, keeps the own name, and marks the row", () => {
    const p = buildPeople(withIdentity(), [], { "i-maya": "Mum" }, NOW).people;
    expect(p.find((x) => x.key === "a")).toMatchObject({
      name: "Mum",
      ownName: "Maya",
      friend: true,
      tappable: true,
    });
  });

  it("gives the same name for the same identity in another album", () => {
    const other = withIdentity();
    other.folder = { id: "f2", role: "member" } as SyncStatus["folder"];
    other.members[1] = { ...other.members[1]!, key: "different-drive" };
    const friends = { "i-maya": "Mum" };
    const first = buildPeople(withIdentity(), [], friends, NOW).people;
    const second = buildPeople(other, [], friends, NOW).people;
    expect(second.find((x) => x.admin)?.name).toBe("Mum");
    expect(first.find((x) => x.admin)?.name).toBe("Mum");
  });

  it("never makes you a friend or tappable", () => {
    const p = buildPeople(withIdentity(), [], { "i-me": "Me" }, NOW).people;
    expect(p[0]).toMatchObject({ you: true, name: "Nils", friend: false, tappable: false });
  });

  it("does not make a member without an identity tappable", () => {
    const alex = buildPeople(withIdentity(), [], {}, NOW).people.find((x) => x.key === "b");
    expect(alex).toMatchObject({ tappable: false, friend: false });
  });
});

describe("buildPeople", () => {
  it("counts connected members and writes the chip text", () => {
    const p = buildPeople(status("member"), [], {}, NOW);
    expect(p.chip).toBe("1 of 2 connected");
    expect(p.connectedCount).toBe(2);
  });

  it("lists you first, then the Admin, with presence wording", () => {
    const p = buildPeople(status("member"), [], {}, NOW);
    expect(p.people.map((x) => x.name)).toEqual(["Nils", "Maya", "Alex"]);
    expect(p.people[0].presence).toBe("you");
    expect(p.people[1].presence).toBe("last seen 2 hr ago");
    expect(p.people[2].presence).toBe("connected");
  });

  it("shows pending requests for this album to the Admin only", () => {
    const reqs = [request("f1"), request("other")];
    expect(buildPeople(status("creator"), reqs, {}, NOW).requests).toHaveLength(1);
    expect(buildPeople(status("member"), reqs, {}, NOW).requests).toHaveLength(0);
  });

  it("names a request by your friend name when its identity is saved", () => {
    const reqs = [{ ...request("f1"), requesterName: "Ben", requesterIdentity: "id-ben" }];
    const [r] = buildPeople(status("creator"), reqs, { "id-ben": "Dad" }, NOW).requests;
    expect(r).toMatchObject({ name: "Dad", friend: true, requesterName: "Ben" });
  });

  it("keeps the asker's own name for a stranger or a request without identity", () => {
    const reqs = [
      { ...request("f1"), requesterName: "Ben", requesterIdentity: "id-x" },
      { ...request("f1"), requesterName: "Zoe" },
    ];
    const rows = buildPeople(status("creator"), reqs, { "id-ben": "Dad" }, NOW).requests;
    expect(rows.map((r) => [r.name, r.friend])).toEqual([
      ["Ben", false],
      ["Zoe", false],
    ]);
  });

  it("handles no status", () => {
    expect(buildPeople(null, [], {}, NOW).chip).toBe("Just you");
  });
});

describe("presenceLabel", () => {
  it("never says online", () => {
    expect(presenceLabel({ connected: true })).toBe("connected");
    expect(presenceLabel({ connected: false })).toBe("not seen yet");
  });
});
