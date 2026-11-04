import {
  createMembershipActor,
  initialStateFromRecords,
  type MembershipPort,
  type MembershipRecords,
  type PortError,
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
  const dropped: string[] = [];
  const port: MembershipPort = {
    addMember: (e) => {
      added.push(e);
      return Promise.resolve(failure ? Either.left(failure) : Either.right());
    },
    removeMember: (k) => {
      dropped.push(k);
      return Promise.resolve(failure ? Either.left(failure) : Either.right());
    },
    ...overrides,
  };
  return { port, added, dropped };
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
    actor.send({ type: "approve" });
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
    actor.send({ type: "approve" });
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
    actor.send({ type: "approve" });
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
    actor.send({ type: "approve" });
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
    actor.send({ type: "approve" });
    await actor.settled();
    actor.send({ type: "approve" });
    await actor.settled();
    expect(actor.state.name).toBe("enrolled");
    expect(outputs).toEqual(["memberEnrolled"]);
  });

  test("ignores approve when the pending request is malformed", async () => {
    const malformed: RequestEntry = JSON.parse(
      JSON.stringify({ ...entry, requestedAt: "yesterday" }),
    );
    const { actor, added, outputs } = setup({ records: { ...empty, requests: { s: malformed } } });
    actor.send({ type: "approve" });
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
    actor.send({ type: "approve" });
    await actor.settled();
    expect(added).toEqual([entry]);
  });

  test("approve, decline and remove from notMember change nothing", async () => {
    const { actor, added, dropped } = setup();
    actor.send({ type: "approve" });
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
    actor.send({ type: "approve" });
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
});
