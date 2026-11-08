import { createMembershipActor, type MembershipPort } from "./membership-machine";
import { VirtualClock } from "@mantaq/core";
import { Either } from "@mantaq/utils";
import { expectAllStatesReached, expectNoDesignErrors } from "@mantaq/inspect";
import { recordRuns } from "@mantaq/inspect/record";
import { describe, expect, test } from "vite-plus/test";

function fakePort(overrides: Partial<MembershipPort> = {}) {
  const calls: string[] = [];
  const port: MembershipPort = {
    makeCollaborator: () => {
      calls.push("makeCollaborator");
      return Promise.resolve(Either.right());
    },
    markLeft: () => {
      calls.push("markLeft");
      return Promise.resolve(Either.right());
    },
    ...overrides,
  };
  return { port, calls };
}

function setup(options: { role?: "reader" | "member"; port?: Partial<MembershipPort> } = {}) {
  const fake = fakePort(options.port);
  const actor = createMembershipActor({
    clock: VirtualClock(),
    port: fake.port,
    start: { role: options.role ?? "reader", joinedAt: 5 },
  });
  return { actor, calls: fake.calls };
}

describe("membership machine", () => {
  test("starts as a Viewer or a Collaborator from the lists", () => {
    expect(setup().actor.state.name).toBe("viewerInAlbum");
    expect(setup({ role: "member" }).actor.state.name).toBe("collaboratorInAlbum");
  });

  test("a Viewer made a Collaborator keeps their join time", async () => {
    const { actor, calls } = setup();
    actor.send({ type: "makeCollaborator" });
    await actor.settled();
    expect({ state: actor.state.name, payload: actor.snapshot().payload, calls }).toEqual({
      state: "collaboratorInAlbum",
      payload: { joinedAt: 5 },
      calls: ["makeCollaborator"],
    });
  });

  test("a failed save keeps the Viewer a Viewer", async () => {
    for (const makeCollaborator of [
      () => Promise.resolve(Either.left({ reason: "disk" })),
      () => Promise.reject(new Error("boom")),
    ]) {
      const { actor } = setup({ port: { makeCollaborator } });
      actor.send({ type: "makeCollaborator" });
      await actor.settled();
      expect({ state: actor.state.name, payload: actor.snapshot().payload }).toEqual({
        state: "viewerInAlbum",
        payload: { joinedAt: 5 },
      });
    }
  });

  test("a left note newer than the join takes a Viewer or Collaborator off", async () => {
    for (const role of ["reader", "member"] as const) {
      const { actor, calls } = setup({ role });
      actor.send({ type: "leftNoteRead", payload: { leftAt: 6 } });
      await actor.settled();
      expect({ state: actor.state.name, calls }).toEqual({
        state: "leftAlbum",
        calls: ["markLeft"],
      });
    }
  });

  test("a left note from before or at the join changes nothing", async () => {
    for (const role of ["reader", "member"] as const) {
      for (const leftAt of [0, 5]) {
        const { actor, calls } = setup({ role });
        const before = actor.state.name;
        actor.send({ type: "leftNoteRead", payload: { leftAt } });
        await actor.settled();
        expect({ state: actor.state.name, calls }).toEqual({ state: before, calls: [] });
      }
    }
  });

  test("leaving while being made a Collaborator wins", async () => {
    const { actor, calls } = setup();
    actor.send({ type: "makeCollaborator" });
    actor.send({ type: "leftNoteRead", payload: { leftAt: 6 } });
    await actor.settled();
    expect(actor.state.name).toBe("leftAlbum");
    expect(calls).toContain("markLeft");
  });

  test("an old left note while being made a Collaborator changes nothing", async () => {
    const { actor } = setup();
    actor.send({ type: "makeCollaborator" });
    actor.send({ type: "leftNoteRead", payload: { leftAt: 0 } });
    await actor.settled();
    expect(actor.state.name).toBe("collaboratorInAlbum");
  });

  test("a failed take-off keeps the role they had", async () => {
    for (const role of ["reader", "member"] as const) {
      const { actor } = setup({
        role,
        port: { markLeft: () => Promise.resolve(Either.left({ reason: "disk" })) },
      });
      actor.send({ type: "leftNoteRead", payload: { leftAt: 6 } });
      await actor.settled();
      expect({ state: actor.state.name, payload: actor.snapshot().payload }).toEqual({
        state: role === "member" ? "collaboratorInAlbum" : "viewerInAlbum",
        payload: { joinedAt: 5 },
      });
    }
  });

  test("a thrown take-off keeps the role they had", async () => {
    const { actor } = setup({ port: { markLeft: () => Promise.reject(new Error("boom")) } });
    actor.send({ type: "leftNoteRead", payload: { leftAt: 6 } });
    await actor.settled();
    expect(actor.state.name).toBe("viewerInAlbum");
  });

  test("inputs a state does not handle are dropped", async () => {
    const collaborator = setup({ role: "member" });
    collaborator.actor.send({ type: "makeCollaborator" });
    await collaborator.actor.settled();
    expect({ state: collaborator.actor.state.name, calls: collaborator.calls }).toEqual({
      state: "collaboratorInAlbum",
      calls: [],
    });
    const gone = setup();
    gone.actor.send({ type: "leftNoteRead", payload: { leftAt: 6 } });
    await gone.actor.settled();
    gone.actor.send({ type: "makeCollaborator" });
    gone.actor.send({ type: "leftNoteRead", payload: { leftAt: 9 } });
    await gone.actor.settled();
    expect({ state: gone.actor.state.name, calls: gone.calls }).toEqual({
      state: "leftAlbum",
      calls: ["markLeft"],
    });
  });
});

describe("membership design", () => {
  const target = {
    id: "membership",
    create: () => createMembershipActor({ clock: VirtualClock() }),
    payloads: { leftNoteRead: [{ leftAt: 2 }] },
  };
  test("has no design errors", () => {
    expectNoDesignErrors(target);
  });
  test("reaches every state", () => {
    expectAllStatesReached(target);
  });
});

const make = recordRuns(createMembershipActor);

test("Ben, a Viewer, leaves while Nils makes him a Collaborator", async () => {
  const actor = make({ clock: VirtualClock() });
  actor.send({ type: "makeCollaborator" });
  actor.send({ type: "leftNoteRead", payload: { leftAt: 2 } });
  await actor.settled();
  expect(actor.state.name).toBe("leftAlbum");
});

test("Ben, a Viewer, leaves, and is gone from Nils's list", async () => {
  const actor = make({ clock: VirtualClock() });
  actor.send({ type: "leftNoteRead", payload: { leftAt: 2 } });
  await actor.settled();
  expect(actor.state.name).toBe("leftAlbum");
});

test("Nils lets Ben add photos", async () => {
  const actor = make({ clock: VirtualClock() });
  actor.send({ type: "makeCollaborator" });
  await actor.settled();
  expect(actor.state.name).toBe("collaboratorInAlbum");
});

test("Letting Ben add photos fails, and he stays a Viewer", async () => {
  const actor = make({ clock: VirtualClock() });
  actor.send({ type: "makeCollaborator" });
  actor.inject({ type: "roleSaveFailed", payload: { reason: "The list could not be saved" } });
  await actor.settled();
  expect(actor.state.name).toBe("viewerInAlbum");
});
