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
import { expectAllStatesReached, expectNoDesignErrors } from "@mantaq/inspect";
import { recordRuns } from "@mantaq/inspect/record";
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
    actor.send({ type: "requestQueued", payload: entry });
    await actor.settled();
    actor.send({ type: "accept", payload: { role: "member" } });
    await actor.settled();
    actor.send({ type: "removeMember" });
    await actor.settled();
    expect({ state: actor.state.name, added, dropped, outputs }).toEqual({
      state: "removed",
      added: [entry],
      dropped: [key],
      outputs: ["memberJoined", "requestAnswered", "memberRemoved"],
    });
  });

  test("decline ends in declined", async () => {
    const { actor, outputs } = setup();
    actor.send({ type: "requestQueued", payload: entry });
    actor.send({ type: "decline" });
    await actor.settled();
    expect(actor.state.name).toBe("declined");
    expect(outputs).toEqual(["requestAnswered"]);
  });

  test("registry write failure returns to awaitingDecision", async () => {
    const { actor, outputs } = setup({ failure: { reason: "disk" } });
    actor.send({ type: "requestQueued", payload: entry });
    actor.send({ type: "accept", payload: { role: "member" } });
    await actor.settled();
    expect(actor.state.name).toBe("awaitingDecision");
    expect(outputs).toEqual([]);
  });

  test("removal failure returns to joined", async () => {
    const { actor, outputs } = setup({ records: enrolledRecords, failure: { reason: "disk" } });
    actor.send({ type: "removeMember" });
    await actor.settled();
    expect(actor.state.name).toBe("joined");
    expect(outputs).toEqual([]);
  });

  test("rejected addMember promise returns to awaitingDecision with no outputs", async () => {
    const { actor, outputs } = setup({
      port: { addMember: () => Promise.reject(new Error("boom")) },
    });
    actor.send({ type: "requestQueued", payload: entry });
    actor.send({ type: "accept", payload: { role: "member" } });
    await actor.settled();
    expect(actor.state.name).toBe("awaitingDecision");
    expect(outputs).toEqual([]);
  });

  test("rejected removeMember promise returns to joined with no outputs", async () => {
    const { actor, outputs } = setup({
      records: enrolledRecords,
      port: { removeMember: () => Promise.reject(new Error("boom")) },
    });
    actor.send({ type: "removeMember" });
    await actor.settled();
    expect(actor.state.name).toBe("joined");
    expect(outputs).toEqual([]);
  });

  test("synchronously throwing addMember returns to awaitingDecision", async () => {
    const { actor, outputs } = setup({
      port: {
        addMember: () => {
          throw new Error("boom");
        },
      },
    });
    actor.send({ type: "requestQueued", payload: entry });
    actor.send({ type: "accept", payload: { role: "member" } });
    await actor.settled();
    expect(actor.state.name).toBe("awaitingDecision");
    expect(outputs).toEqual([]);
  });

  test("synchronously throwing removeMember returns to joined", async () => {
    const { actor, outputs } = setup({
      records: enrolledRecords,
      port: {
        removeMember: () => {
          throw new Error("boom");
        },
      },
    });
    actor.send({ type: "removeMember" });
    await actor.settled();
    expect(actor.state.name).toBe("joined");
    expect(outputs).toEqual([]);
  });

  test("returns joined when accept is retried after a write failure", async () => {
    let calls = 0;
    const { actor, outputs } = setup({
      port: {
        addMember: () => {
          calls += 1;
          return Promise.resolve(calls === 1 ? Either.left({ reason: "disk" }) : Either.right());
        },
      },
    });
    actor.send({ type: "requestQueued", payload: entry });
    actor.send({ type: "accept", payload: { role: "member" } });
    await actor.settled();
    actor.send({ type: "accept", payload: { role: "member" } });
    await actor.settled();
    expect(actor.state.name).toBe("joined");
    expect(outputs).toEqual(["memberJoined", "requestAnswered"]);
  });

  test("ignores accept when the pending request is malformed", async () => {
    const malformed: RequestEntry = JSON.parse(
      JSON.stringify({ ...entry, requestedAt: "yesterday" }),
    );
    const { actor, added, outputs } = setup({ records: { ...empty, requests: { s: malformed } } });
    actor.send({ type: "accept", payload: { role: "member" } });
    await actor.settled();
    expect(actor.state.name).toBe("awaitingDecision");
    expect(added).toEqual([]);
    expect(outputs).toEqual([]);
  });

  test("a second requestQueued while pending keeps the first entry", async () => {
    const { actor, added } = setup();
    const other = { ...entry, folderName: "Other" };
    actor.send({ type: "requestQueued", payload: entry });
    actor.send({ type: "requestQueued", payload: other });
    actor.send({ type: "accept", payload: { role: "member" } });
    await actor.settled();
    expect(added).toEqual([entry]);
  });

  test("accept, decline and remove from noRequest change nothing", async () => {
    const { actor, added, dropped } = setup();
    actor.send({ type: "accept", payload: { role: "member" } });
    actor.send({ type: "decline" });
    actor.send({ type: "removeMember" });
    await actor.settled();
    expect(actor.state.name).toBe("noRequest");
    expect(added).toEqual([]);
    expect(dropped).toEqual([]);
  });

  test("ignores decline and accept while joined", async () => {
    const { actor, added } = setup({ records: enrolledRecords });
    actor.send({ type: "decline" });
    actor.send({ type: "accept", payload: { role: "member" } });
    await actor.settled();
    expect(actor.state.name).toBe("joined");
    expect(added).toEqual([]);
  });

  test("a removed member ignores further requests and removals", async () => {
    const { actor, dropped } = setup({ records: enrolledRecords });
    actor.send({ type: "removeMember" });
    await actor.settled();
    actor.send({ type: "requestQueued", payload: entry });
    actor.send({ type: "removeMember" });
    await actor.settled();
    expect(actor.state.name).toBe("removed");
    expect(dropped).toEqual([key]);
  });

  test("returns noRequest for empty records", () => {
    expect(stateName(initialStateFromRecords({ records: empty, memberKey: key }))).toBe(
      "noRequest",
    );
  });

  test("returns awaitingDecision for a matching request", () => {
    const initial = initialStateFromRecords({
      records: { ...empty, requests: { s: entry } },
      memberKey: key,
    });
    expect(stateName(initial)).toBe("awaitingDecision");
  });

  test("returns joined for a registry member", () => {
    expect(stateName(initialStateFromRecords({ records: enrolledRecords, memberKey: key }))).toBe(
      "joined",
    );
  });

  test("returns removed over joined and pending records", () => {
    const records: MembershipRecords = {
      ...enrolledRecords,
      requests: { s: entry },
      removed: { version: 1, removed: { x: { memberKey: key, removedAt: 2 } } },
    };
    expect(stateName(initialStateFromRecords({ records, memberKey: key }))).toBe("removed");
  });

  test("accept as reader and as member both enroll with that role", async () => {
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
      actor.send({ type: "requestQueued", payload: entry });
      actor.send({ type: "accept", payload: { role } });
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
      state: "joined",
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
        state: "joined",
        payload: { role: "member" },
      });
    }
  });

  test("a failed role change after an accept-as-reader keeps reader", async () => {
    const { actor } = setup({
      port: { setRole: () => Promise.resolve(Either.left({ reason: "disk" })) },
    });
    actor.send({ type: "requestQueued", payload: entry });
    actor.send({ type: "accept", payload: { role: "reader" } });
    await actor.settled();
    actor.send({ type: "changeRole", payload: { role: "member" } });
    await actor.settled();
    expect(actor.snapshot().payload).toEqual({ role: "reader" });
  });

  test("changeRole is ignored outside joined", async () => {
    for (const records of [empty, { ...empty, requests: { s: entry } }]) {
      const { actor, roles } = setup({ records });
      const before = actor.state.name;
      actor.send({ type: "changeRole", payload: { role: "reader" } });
      await actor.settled();
      expect({ state: actor.state.name, roles }).toEqual({ state: before, roles: [] });
    }
    const removedRun = setup({ records: enrolledRecords });
    removedRun.actor.send({ type: "removeMember" });
    await removedRun.actor.settled();
    removedRun.actor.send({ type: "changeRole", payload: { role: "reader" } });
    await removedRun.actor.settled();
    expect({ state: removedRun.actor.state.name, roles: removedRun.roles }).toEqual({
      state: "removed",
      roles: [],
    });
  });

  test("accept with no request is ignored", async () => {
    const { actor, added } = setup();
    actor.send({ type: "accept", payload: { role: "reader" } });
    await actor.settled();
    expect({ state: actor.state.name, added }).toEqual({ state: "noRequest", added: [] });
  });
});

const make = recordRuns(createMembershipActor);

async function walkTo(steps: (actor: ReturnType<typeof make>) => Promise<void>) {
  const actor = make({ clock: VirtualClock() });
  await steps(actor);
  return actor;
}

async function receive(actor: ReturnType<typeof make>) {
  actor.send({ type: "requestQueued", payload: entry });
  await actor.settled();
}

async function acceptAs(actor: ReturnType<typeof make>, role: Role) {
  actor.send({ type: "accept", payload: { role } });
  await actor.settled();
}

test("Nils: accepts Maya as Collaborator", async () => {
  const actor = await walkTo(async (a) => {
    await receive(a);
    await acceptAs(a, "member");
  });
  expect(actor.state.name).toBe("joined");
  expect(actor.snapshot().payload).toEqual({ role: "member" });
});

test("Nils: declines the request", async () => {
  const actor = await walkTo(async (a) => {
    await receive(a);
    a.send({ type: "decline" });
    await a.settled();
  });
  expect(actor.state.name).toBe("declined");
});

test("Nils: accepts a guest as Collaborator", async () => {
  const actor = await walkTo(async (a) => {
    await receive(a);
    await acceptAs(a, "member");
  });
  expect(actor.state.name).toBe("joined");
  expect(actor.snapshot().payload).toEqual({ role: "member" });
});

test("Nils: accepts a relative as Viewer, later makes her a Collaborator", async () => {
  const actor = await walkTo(async (a) => {
    await receive(a);
    await acceptAs(a, "reader");
    a.send({ type: "changeRole", payload: { role: "member" } });
    await a.settled();
  });
  expect(actor.state.name).toBe("joined");
  expect(actor.snapshot().payload).toEqual({ role: "member" });
});

describe("membership after a decline", () => {
  test("a new request makes the Admin decide again", async () => {
    const { actor, added } = setup();
    actor.send({ type: "requestQueued", payload: entry });
    actor.send({ type: "decline" });
    actor.send({ type: "requestQueued", payload: entry });
    await actor.settled();
    expect(actor.state.name).toBe("awaitingDecision");
    actor.send({ type: "accept", payload: { role: "member" } });
    await actor.settled();
    expect({ state: actor.state.name, added }).toEqual({ state: "joined", added: [entry] });
  });

  test("accept, changeRole and removeMember are ignored", async () => {
    const { actor, added, roles, dropped } = setup();
    actor.send({ type: "requestQueued", payload: entry });
    actor.send({ type: "decline" });
    actor.send({ type: "accept", payload: { role: "member" } });
    actor.send({ type: "changeRole", payload: { role: "member" } });
    actor.send({ type: "removeMember" });
    await actor.settled();
    expect({ state: actor.state.name, added, roles, dropped }).toEqual({
      state: "declined",
      added: [],
      roles: [],
      dropped: [],
    });
  });
});

describe("membership design", () => {
  const target = {
    id: "membership",
    create: () => createMembershipActor({ clock: VirtualClock() }),
    payloads: {
      requestQueued: [entry],
      accept: [{ role: "member" }],
      changeRole: [{ role: "reader" }],
    },
  };
  test("has no design errors", () => {
    expectNoDesignErrors(target);
  });
  test("reaches every state", () => {
    expectAllStatesReached(target);
  });
});
