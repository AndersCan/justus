import {
  createMembershipActor,
  initialStateFromRecords,
  type MembershipPort,
  type MembershipRecords,
  type PortError,
  type Role,
  type RequestEntry,
} from "./membership-machine";
import { VirtualClock } from "@mantaq/core";
import { onOutput } from "@mantaq/sugar";
import { Either } from "@mantaq/utils";
import { describe, expect, test } from "vite-plus/test";

const key = "a".repeat(64);
const entry: RequestEntry = {
  requesterKey: key,
  requesterName: "Ann",
  shareKey: "b".repeat(64),
  folderName: "Trip",
  requestedAt: 1,
};
const empty: MembershipRecords = {
  registry: { version: 1, members: {} },
  removed: { version: 1, removed: {} },
  requests: {},
};
const enrolledRecords: MembershipRecords = {
  ...empty,
  registry: { version: 1, members: { x: { key, name: "Ann", addedAt: 1 } } },
};

function stateName(value: { name: string } | { state: { name: string } }) {
  return "state" in value ? value.state.name : value.name;
}

type PortOverrides = Partial<MembershipPort>;

function fakePort(options: { failure?: PortError; overrides?: PortOverrides }) {
  const { failure, overrides } = options;
  const added: RequestEntry[] = [];
  const roles: Role[] = [];
  const dropped: string[] = [];
  const port: MembershipPort = {
    addMember: (e) => {
      added.push(e);
      return Promise.resolve(failure ? Either.left(failure) : Either.right());
    },
    setRole: (_k, role) => {
      roles.push(role);
      return Promise.resolve(failure ? Either.left(failure) : Either.right());
    },
    removeMember: (k) => {
      dropped.push(k);
      return Promise.resolve(failure ? Either.left(failure) : Either.right());
    },
    ...overrides,
  };
  return { port, added, roles, dropped };
}

function setup(
  options: { records?: MembershipRecords; failure?: PortError; port?: PortOverrides } = {},
) {
  const fake = fakePort({ failure: options.failure, overrides: options.port });
  const actor = createMembershipActor({
    clock: VirtualClock(),
    port: fake.port,
    records: options.records ?? empty,
    memberKey: key,
  });
  const outputs: string[] = [];
  onOutput(actor, (e) => outputs.push(e.type));
  return { actor, outputs, ...fake };
}

describe("membership machine", () => {
  test("enrolls then removes a member and emits both outputs", async () => {
    const { actor, outputs, added, dropped } = setup();
    actor.send({ type: "requestSent", payload: entry });
    await actor.settled();
    actor.send({ type: "approve", payload: { role: "member" } });
    await actor.settled();
    actor.send({ type: "remove" });
    await actor.settled();
    expect({ state: actor.state.name, added, dropped, outputs }).toEqual({
      state: "removed",
      added: [entry],
      dropped: [key],
      outputs: ["memberEnrolled", "memberRemoved"],
    });
  });

  test("decline returns to notMember", async () => {
    const { actor } = setup();
    actor.send({ type: "requestSent", payload: entry });
    actor.send({ type: "decline" });
    await actor.settled();
    expect(actor.state.name).toBe("notMember");
  });

  test("registry write failure returns to requestPending", async () => {
    const { actor, outputs } = setup({ failure: { reason: "disk" } });
    actor.send({ type: "requestSent", payload: entry });
    actor.send({ type: "approve", payload: { role: "member" } });
    await actor.settled();
    expect(actor.state.name).toBe("requestPending");
    expect(outputs).toEqual([]);
  });

  test("removal failure returns to enrolled", async () => {
    const { actor, outputs } = setup({ records: enrolledRecords, failure: { reason: "disk" } });
    actor.send({ type: "remove" });
    await actor.settled();
    expect(actor.state.name).toBe("enrolled");
    expect(outputs).toEqual([]);
  });

  test("rejected addMember promise returns to requestPending with no outputs", async () => {
    const { actor, outputs } = setup({
      port: { addMember: () => Promise.reject(new Error("boom")) },
    });
    actor.send({ type: "requestSent", payload: entry });
    actor.send({ type: "approve", payload: { role: "member" } });
    await actor.settled();
    expect(actor.state.name).toBe("requestPending");
    expect(outputs).toEqual([]);
  });

  test("rejected removeMember promise returns to enrolled with no outputs", async () => {
    const { actor, outputs } = setup({
      records: enrolledRecords,
      port: { removeMember: () => Promise.reject(new Error("boom")) },
    });
    actor.send({ type: "remove" });
    await actor.settled();
    expect(actor.state.name).toBe("enrolled");
    expect(outputs).toEqual([]);
  });

  test("synchronously throwing addMember returns to requestPending", async () => {
    const { actor, outputs } = setup({
      port: {
        addMember: () => {
          throw new Error("boom");
        },
      },
    });
    actor.send({ type: "requestSent", payload: entry });
    actor.send({ type: "approve", payload: { role: "member" } });
    await actor.settled();
    expect(actor.state.name).toBe("requestPending");
    expect(outputs).toEqual([]);
  });

  test("synchronously throwing removeMember returns to enrolled", async () => {
    const { actor, outputs } = setup({
      records: enrolledRecords,
      port: {
        removeMember: () => {
          throw new Error("boom");
        },
      },
    });
    actor.send({ type: "remove" });
    await actor.settled();
    expect(actor.state.name).toBe("enrolled");
    expect(outputs).toEqual([]);
  });

  test("returns enrolled when approve is retried after a write failure", async () => {
    let calls = 0;
    const { actor, outputs } = setup({
      port: {
        addMember: () => {
          calls += 1;
          return Promise.resolve(calls === 1 ? Either.left({ reason: "disk" }) : Either.right());
        },
      },
    });
    actor.send({ type: "requestSent", payload: entry });
    actor.send({ type: "approve", payload: { role: "member" } });
    await actor.settled();
    actor.send({ type: "approve", payload: { role: "member" } });
    await actor.settled();
    expect(actor.state.name).toBe("enrolled");
    expect(outputs).toEqual(["memberEnrolled"]);
  });

  test("ignores approve when the pending request is malformed", async () => {
    const malformed: RequestEntry = JSON.parse(
      JSON.stringify({ ...entry, requestedAt: "yesterday" }),
    );
    const { actor, added, outputs } = setup({ records: { ...empty, requests: { s: malformed } } });
    actor.send({ type: "approve", payload: { role: "member" } });
    await actor.settled();
    expect(actor.state.name).toBe("requestPending");
    expect(added).toEqual([]);
    expect(outputs).toEqual([]);
  });

  test("a second requestSent while pending keeps the first entry", async () => {
    const { actor, added } = setup();
    const other = { ...entry, folderName: "Other" };
    actor.send({ type: "requestSent", payload: entry });
    actor.send({ type: "requestSent", payload: other });
    actor.send({ type: "approve", payload: { role: "member" } });
    await actor.settled();
    expect(added).toEqual([entry]);
  });

  test("approve, decline and remove from notMember change nothing", async () => {
    const { actor, added, dropped } = setup();
    actor.send({ type: "approve", payload: { role: "member" } });
    actor.send({ type: "decline" });
    actor.send({ type: "remove" });
    await actor.settled();
    expect(actor.state.name).toBe("notMember");
    expect(added).toEqual([]);
    expect(dropped).toEqual([]);
  });

  test("ignores decline and approve while enrolled", async () => {
    const { actor, added } = setup({ records: enrolledRecords });
    actor.send({ type: "decline" });
    actor.send({ type: "approve", payload: { role: "member" } });
    await actor.settled();
    expect(actor.state.name).toBe("enrolled");
    expect(added).toEqual([]);
  });

  test("a removed member ignores further requests and removals", async () => {
    const { actor, dropped } = setup({ records: enrolledRecords });
    actor.send({ type: "remove" });
    await actor.settled();
    actor.send({ type: "requestSent", payload: entry });
    actor.send({ type: "remove" });
    await actor.settled();
    expect(actor.state.name).toBe("removed");
    expect(dropped).toEqual([key]);
  });

  test("returns notMember for empty records", () => {
    expect(stateName(initialStateFromRecords({ records: empty, memberKey: key }))).toBe(
      "notMember",
    );
  });

  test("returns requestPending for a matching request", () => {
    const initial = initialStateFromRecords({
      records: { ...empty, requests: { s: entry } },
      memberKey: key,
    });
    expect(stateName(initial)).toBe("requestPending");
  });

  test("returns enrolled for a registry member", () => {
    expect(stateName(initialStateFromRecords({ records: enrolledRecords, memberKey: key }))).toBe(
      "enrolled",
    );
  });

  test("returns removed over enrolled and pending records", () => {
    const records: MembershipRecords = {
      ...enrolledRecords,
      requests: { s: entry },
      removed: { version: 1, removed: { x: { memberKey: key, removedAt: 2 } } },
    };
    expect(stateName(initialStateFromRecords({ records, memberKey: key }))).toBe("removed");
  });

  test("approve as reader and as member both enroll with that role", async () => {
    const seen: Array<{ role: Role; state: unknown }> = [];
    for (const role of ["reader", "member"] as const) {
      const roles: Role[] = [];
      const { actor } = setup({
        port: {
          addMember: (_e, r) => {
            roles.push(r);
            return Promise.resolve(Either.right());
          },
        },
      });
      actor.send({ type: "requestSent", payload: entry });
      actor.send({ type: "approve", payload: { role } });
      await actor.settled();
      seen.push({ role: roles[0] as Role, state: actor.snapshot().payload });
    }
    expect(seen).toEqual([
      { role: "reader", state: { role: "reader" } },
      { role: "member", state: { role: "member" } },
    ]);
  });

  test("changes role both ways", async () => {
    const { actor, roles } = setup({ records: enrolledRecords });
    actor.send({ type: "changeRole", payload: { role: "reader" } });
    await actor.settled();
    expect(actor.snapshot().payload).toEqual({ role: "reader" });
    actor.send({ type: "changeRole", payload: { role: "member" } });
    await actor.settled();
    expect({ state: actor.state.name, payload: actor.snapshot().payload, roles }).toEqual({
      state: "enrolled",
      payload: { role: "member" },
      roles: ["reader", "member"],
    });
  });

  test("a failed role change keeps the old role", async () => {
    for (const port of [
      { setRole: () => Promise.resolve(Either.left({ reason: "disk" })) },
      { setRole: () => Promise.reject(new Error("boom")) },
    ]) {
      const { actor } = setup({ records: enrolledRecords, port });
      actor.send({ type: "changeRole", payload: { role: "reader" } });
      await actor.settled();
      expect({ state: actor.state.name, payload: actor.snapshot().payload }).toEqual({
        state: "enrolled",
        payload: { role: "member" },
      });
    }
  });

  test("a failed role change after an approve-as-reader keeps reader", async () => {
    const { actor } = setup({
      port: { setRole: () => Promise.resolve(Either.left({ reason: "disk" })) },
    });
    actor.send({ type: "requestSent", payload: entry });
    actor.send({ type: "approve", payload: { role: "reader" } });
    await actor.settled();
    actor.send({ type: "changeRole", payload: { role: "member" } });
    await actor.settled();
    expect(actor.snapshot().payload).toEqual({ role: "reader" });
  });

  test("changeRole is ignored outside enrolled", async () => {
    for (const records of [empty, { ...empty, requests: { s: entry } }]) {
      const { actor, roles } = setup({ records });
      const before = actor.state.name;
      actor.send({ type: "changeRole", payload: { role: "reader" } });
      await actor.settled();
      expect({ state: actor.state.name, roles }).toEqual({ state: before, roles: [] });
    }
    const removedRun = setup({ records: enrolledRecords });
    removedRun.actor.send({ type: "remove" });
    await removedRun.actor.settled();
    removedRun.actor.send({ type: "changeRole", payload: { role: "reader" } });
    await removedRun.actor.settled();
    expect({ state: removedRun.actor.state.name, roles: removedRun.roles }).toEqual({
      state: "removed",
      roles: [],
    });
  });

  test("approve with no request is ignored", async () => {
    const { actor, added } = setup();
    actor.send({ type: "approve", payload: { role: "reader" } });
    await actor.settled();
    expect({ state: actor.state.name, added }).toEqual({ state: "notMember", added: [] });
  });
});

/** Each walk is the same steps as the link in docs/design/sharing-flows.md (Walks). */
const WALK_REQUEST = `requestSent=${JSON.stringify(entry)}`;
const MEMBERSHIP_WALKS: [string, string[], string, unknown][] = [
  [
    "Story 1, Nils: accepts Maya as Collaborator",
    [WALK_REQUEST, 'approve={"role":"member"}'],
    "enrolled",
    { role: "member" },
  ],
  ["Story 1, Nils: declines the request", [WALK_REQUEST, "decline"], "notMember", undefined],
  [
    "Story 2, Nils: accepts a guest as Collaborator",
    [WALK_REQUEST, 'approve={"role":"member"}'],
    "enrolled",
    { role: "member" },
  ],
  [
    "Story 3, Nils: accepts a relative as Viewer, later makes her a Collaborator",
    [WALK_REQUEST, 'approve={"role":"reader"}', 'changeRole={"role":"member"}'],
    "enrolled",
    { role: "member" },
  ],
];

describe("membership walks", () => {
  test.each(MEMBERSHIP_WALKS)("%s", async (_name, steps, finalState, finalPayload) => {
    const actor = createMembershipActor({ clock: VirtualClock() });
    for (const step of steps) {
      const cut = step.indexOf("=");
      if (cut === -1) actor.send({ type: step } as never);
      else
        actor.send({
          type: step.slice(0, cut),
          payload: JSON.parse(step.slice(cut + 1)),
        } as never);
      await actor.settled();
    }
    expect(actor.state.name).toBe(finalState);
    if (finalPayload !== undefined) expect(actor.snapshot().payload).toEqual(finalPayload);
  });
});
