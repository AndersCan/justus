import { describe, it, expect } from "vite-plus/test";
import type { JoinRequest, SyncStatus } from "@justus/core";
import type { RequestRow } from "./people";
import {
  buildPeople,
  clashFriend,
  presenceLabel,
  nameList,
  requestRowOf,
  requestsHint,
} from "./people";

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

describe("clashFriend", () => {
  const friends = { "id-ben": "Dad", "id-ann": "Ann Lee" };
  it.each([
    ["dad", "Dad"],
    ["  DAD ", "Dad"],
    ["ann   lee", "Ann Lee"],
    ["Dadd", undefined],
    ["Dad 2", undefined],
    ["", undefined],
    ["   ", undefined],
  ])("%j -> %j", (name, want) => {
    expect(clashFriend(name, friends)).toBe(want);
  });
  it("matches nothing without friends", () => {
    expect(clashFriend("Dad", {})).toBeUndefined();
  });
  it("returns the smaller saved name when two friends match", () => {
    expect(clashFriend("dad", { a: "dad", b: "Dad" })).toBe("Dad");
    expect(clashFriend("dad", { a: "Dad", b: "dad" })).toBe("Dad");
  });
});

describe("buildPeople name clash", () => {
  const friends = { "id-ben": "Dad" };
  const ask = (key: string, name: string, identity?: string): JoinRequest => ({
    ...request("f1"),
    requesterKey: key,
    requesterName: name,
    ...(identity !== undefined && { requesterIdentity: identity }),
  });
  const admin = (): SyncStatus =>
    ({
      folder: { id: "f1", role: "creator" },
      members: [
        { key: "me", name: "Dad", admin: true, connected: true, identity: "i-me" },
        { key: "m1", name: "Ben", admin: false, connected: true, identity: "id-ben" },
        { key: "m2", name: "dad", admin: false, connected: true, identity: "id-x" },
        { key: "m3", name: "DAD", admin: false, connected: true },
      ],
    }) as SyncStatus;

  it("marks non-friend requests that use a friend's name", () => {
    const rows = buildPeople(
      admin(),
      [ask("r1", "Ben", "id-ben"), ask("r2", " dad ", "id-x"), ask("r3", "DAD")],
      friends,
      NOW,
    ).requests;
    expect(rows.find((r) => r.requesterKey === "r1")).not.toHaveProperty("clash");
    expect(rows.find((r) => r.requesterKey === "r2")).toMatchObject({
      clash: "Dad",
      name: " dad ",
    });
    expect(rows.find((r) => r.requesterKey === "r3")).toMatchObject({ clash: "Dad" });
  });

  it("a friend is never a clash, even when another friend has the same name", () => {
    const rows = buildPeople(
      admin(),
      [ask("r1", "Ben", "id-ben")],
      { "id-ben": "Dad", z: "Ben" },
      NOW,
    ).requests;
    expect(rows[0]).not.toHaveProperty("clash");
  });

  it("marks members that are not you or a friend", () => {
    const p = buildPeople(admin(), [], friends, NOW).people;
    const by = (k: string) => p.find((x) => x.key === k)!;
    expect(by("m2").clash).toBe("Dad");
    expect(by("m3").clash).toBe("Dad");
    expect(by("m1")).not.toHaveProperty("clash");
    expect(by("me")).not.toHaveProperty("clash");
  });

  it("marks nobody without friends", () => {
    const vm = buildPeople(admin(), [ask("r2", "dad", "id-x")], {}, NOW);
    expect(vm.requests.some((r) => "clash" in r)).toBe(false);
    expect(vm.people.some((x) => "clash" in x)).toBe(false);
  });
});

describe("requestsHint", () => {
  const row = (over: Partial<RequestRow>): RequestRow => ({
    ...request("f1"),
    name: "Sam",
    friend: false,
    ...over,
  });
  it("asks for the code when a row has one", () => {
    expect(requestsHint([row({ checkCode: "a b c" })])).toBe(
      "Not sure who it is? Ask them which three words their phone shows.",
    );
  });
  it("warns when a row clashes, even with a code", () => {
    expect(requestsHint([row({ checkCode: "a b c", clash: "Dad" })])).toBe(
      "Someone not in your friends typed a friend's name. Ask which three words their phone shows before you accept.",
    );
  });
  it("says how many asked by link at 2 or more, before the code hint", () => {
    const r = row({ viaInvite: true, checkCode: "a b c" });
    expect(requestsHint([r, r])).toBe(
      "2 people asked with your invite link. Decline anyone you don't know. Not sure who it is? Ask them which three words their phone shows.",
    );
  });
  it("keeps the clash warning after the count", () => {
    expect(
      requestsHint([
        row({ viaInvite: true, checkCode: "a b c" }),
        row({ viaInvite: true, clash: "Dad" }),
      ]),
    ).toBe(
      "2 people asked with your invite link. Decline anyone you don't know. Someone not in your friends typed a friend's name. Ask which three words their phone shows before you accept.",
    );
  });
  it("says only the count when link asks have no code", () => {
    expect(requestsHint([row({ viaInvite: true }), row({ viaInvite: true })])).toBe(
      "2 people asked with your invite link. Decline anyone you don't know.",
    );
  });
  it("counts only the link asks in the number", () => {
    expect(requestsHint([row({ viaInvite: true }), row({ viaInvite: true }), row({})])).toBe(
      "2 people asked with your invite link. Decline anyone you don't know.",
    );
  });
  it("counts only link asks", () => {
    expect(
      requestsHint([row({ viaInvite: true, checkCode: "a b c" }), row({ checkCode: "d e f" })]),
    ).toBe("Not sure who it is? Ask them which three words their phone shows.");
  });
  it("is empty otherwise", () => {
    expect(requestsHint([row({})])).toBe("");
    expect(requestsHint([])).toBe("");
  });
});

describe("requestRowOf", () => {
  const r = (requesterName: string, requesterIdentity?: string) =>
    ({ folderId: "f1", requesterKey: "k", requesterName, requesterIdentity }) as JoinRequest;

  it("names a saved friend by the saved name", () => {
    const row = requestRowOf(r("Maya", "i-maya"), { "i-maya": "Mum" });
    expect(row).toMatchObject({ name: "Mum", friend: true });
    expect(row.clash).toBeUndefined();
  });

  it("flags a stranger who typed a friend's name", () => {
    expect(requestRowOf(r("mum", "i-x"), { "i-maya": "Mum" })).toMatchObject({
      name: "mum",
      friend: false,
      clash: "Mum",
    });
  });

  it("keeps the typed name for anyone else", () => {
    const row = requestRowOf(r("Ben"), { "i-maya": "Mum" });
    expect(row).toMatchObject({ name: "Ben", friend: false });
    expect("clash" in row).toBe(false);
  });
});

describe("nameList", () => {
  it.each([
    [[], ""],
    [["Ann"], "Ann"],
    [["Ann", "Bo"], "Ann and Bo"],
    [["Ann", "Bo", "Cy"], "Ann, Bo and Cy"],
    [["Ann", "Bo", "Cy", "Di", "Ed", "Flo"], "Ann, Bo, Cy, Di, Ed and Flo"],
  ])("%j", (names, text) => {
    expect(nameList(names)).toBe(text);
  });
});

describe("person role", () => {
  const roleOf = (folder: Record<string, unknown>, members?: unknown[]) =>
    buildPeople(
      {
        ...status("member"),
        folder: { id: "f1", ...folder },
        ...(members && { members }),
      } as SyncStatus,
      [],
      {},
      NOW,
    ).people;

  it("own row role follows the album", () => {
    expect(roleOf({ role: "creator" })[0].role).toBe("admin");
    expect(roleOf({ role: "member" })[0].role).toBe("collaborator");
    expect(roleOf({ role: "reader" })[0].role).toBe("viewer");
    expect(roleOf({ role: "reader", pending: true })[0].role).toBe("waiting");
    expect(roleOf({ role: "member", pending: true })[0].role).toBe("waiting");
  });

  it("other rows' role comes from admin and viewer", () => {
    const people = roleOf({ role: "creator" }, [
      { key: "me", name: "Me", admin: true, connected: true },
      { key: "a", name: "Ann", admin: true, connected: true },
      { key: "v", name: "Vic", admin: false, viewer: true, connected: true },
      { key: "c", name: "Cy", admin: false, connected: true },
    ]);
    expect(people.map((p) => [p.name, p.role])).toEqual([
      ["Me", "admin"],
      ["Ann", "admin"],
      ["Vic", "viewer"],
      ["Cy", "collaborator"],
    ]);
  });
});
