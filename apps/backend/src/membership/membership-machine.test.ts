import { VirtualClock } from "@mantaq/core";
import { onOutput } from "@mantaq/sugar";
import { Either } from "@mantaq/utils";
import { describe, expect, test } from "vite-plus/test";
import {
  createMembershipActor,
  initialStateFromRecords,
  type MembershipPort,
  type MembershipRecords,
  type PortError,
  type RequestEntry,
} from "./membership-machine";

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

function stateName(s: { name: string } | { state: { name: string } }) {
  return "state" in s ? s.state.name : s.name;
}

function fakePort(failure?: PortError) {
  const added: RequestEntry[] = [];
  const dropped: string[] = [];
  const port: MembershipPort = {
    addMember: (e) => {
      added.push(e);
      return Promise.resolve(failure ? Either.left(failure) : Either.right({}));
    },
    removeMember: (k) => {
      dropped.push(k);
      return Promise.resolve(failure ? Either.left(failure) : Either.right({}));
    },
  };
  return { port, added, dropped };
}

function setup(records: MembershipRecords = empty, failure?: PortError) {
  const fake = fakePort(failure);
  const actor = createMembershipActor({
    clock: VirtualClock(),
    port: fake.port,
    records,
    memberKey: key,
  });
  const outputs: string[] = [];
  onOutput(actor, (e) => outputs.push(e.type));
  return { actor, outputs, ...fake };
}

describe("membership machine", () => {
  test("request, approve, remove", async () => {
    const { actor, outputs, added, dropped } = setup();
    actor.send({ type: "requestSent", payload: entry });
    await actor.settled();
    expect(actor.state.name).toBe("requestPending");
    actor.send({ type: "approve" });
    await actor.settled();
    expect(actor.state.name).toBe("enrolled");
    expect(added).toEqual([entry]);
    actor.send({ type: "remove" });
    await actor.settled();
    expect(actor.state.name).toBe("removed");
    expect(dropped).toEqual([key]);
    expect(outputs).toEqual(["memberEnrolled", "memberRemoved"]);
  });

  test("decline returns to notMember", async () => {
    const { actor } = setup();
    actor.send({ type: "requestSent", payload: entry });
    actor.send({ type: "decline" });
    await actor.settled();
    expect(actor.state.name).toBe("notMember");
  });

  test("registry write failure returns to requestPending", async () => {
    const { actor, outputs } = setup(empty, { reason: "disk" });
    actor.send({ type: "requestSent", payload: entry });
    actor.send({ type: "approve" });
    await actor.settled();
    expect(actor.state.name).toBe("requestPending");
    expect(outputs).toEqual([]);
  });

  test("removal failure returns to enrolled", async () => {
    const { actor, outputs } = setup(enrolledRecords, { reason: "disk" });
    actor.send({ type: "remove" });
    await actor.settled();
    expect(actor.state.name).toBe("enrolled");
    expect(outputs).toEqual([]);
  });

  test("illegal moves are no-ops", async () => {
    const fresh = setup();
    fresh.actor.send({ type: "approve" });
    fresh.actor.send({ type: "decline" });
    fresh.actor.send({ type: "remove" });
    await fresh.actor.settled();
    expect(fresh.actor.state.name).toBe("notMember");
    expect(fresh.added).toEqual([]);

    const member = setup(enrolledRecords);
    member.actor.send({ type: "decline" });
    member.actor.send({ type: "approve" });
    await member.actor.settled();
    expect(member.actor.state.name).toBe("enrolled");

    const gone = setup(enrolledRecords);
    gone.actor.send({ type: "remove" });
    await gone.actor.settled();
    gone.actor.send({ type: "requestSent", payload: entry });
    gone.actor.send({ type: "remove" });
    await gone.actor.settled();
    expect(gone.actor.state.name).toBe("removed");
    expect(gone.dropped).toEqual([key]);
  });

  test("initial state from records", () => {
    expect(stateName(initialStateFromRecords(empty, key))).toBe("notMember");
    expect(stateName(initialStateFromRecords({ ...empty, requests: { s: entry } }, key))).toBe(
      "requestPending",
    );
    expect(stateName(initialStateFromRecords(enrolledRecords, key))).toBe("enrolled");
    expect(
      stateName(
        initialStateFromRecords(
          {
            ...enrolledRecords,
            requests: { s: entry },
            removed: { version: 1, removed: { x: { memberKey: key, removedAt: 2 } } },
          },
          key,
        ),
      ),
    ).toBe("removed");
  });
});
