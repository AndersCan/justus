import { describe, expect, test, vi, beforeEach } from "vite-plus/test";
import { VirtualClock } from "@mantaq/core";
import { onOutput } from "@mantaq/sugar";
import { $peopleError, $peopleState, createPeopleActor, people } from "./people-machine";
import { gateway } from "../gateway";

const mock = gateway as any;

vi.mock("../gateway", () => ({
  gateway: {
    removeMember: vi.fn(),
    requests: vi.fn().mockResolvedValue([null, { requests: [] }]),
    respond: vi.fn(),
    logs: { view: vi.fn(), clear: vi.fn() },
  },
}));

beforeEach(() => {
  mock.removeMember.mockReset().mockResolvedValue([null, { ok: true }]);
  people.close();
  $peopleError.set(null);
});

describe("people machine", () => {
  test("opens and closes the sheet", () => {
    people.open();
    expect($peopleState.get()).toBe("open");
    people.close();
    expect($peopleState.get()).toBe("closed");
  });

  test("removing a member returns to the open sheet", async () => {
    people.open();
    people.remove("f1", "k1");
    await vi.waitFor(() => expect($peopleState.get()).toBe("open"));
    expect(mock.removeMember).toHaveBeenCalledWith("f1", "k1");
  });

  test("a failed removal keeps the sheet open with the error", async () => {
    mock.removeMember.mockResolvedValue([new Error("not the Admin"), null]);
    people.open();
    people.remove("f1", "k1");
    await vi.waitFor(() => expect($peopleError.get()).toBe("not the Admin"));
    expect($peopleState.get()).toBe("open");
  });
});

describe("people factory", () => {
  const send = (actor: ReturnType<typeof createPeopleActor>, type: string, payload?: unknown) =>
    (actor as any).send({ type, payload });

  function build(
    removeMember: (folderId: string, memberKey: string) => Promise<[unknown, unknown]>,
  ) {
    const actor = createPeopleActor({
      clock: VirtualClock(),
      gateway: { removeMember } as any,
    });
    const outputs: string[] = [];
    onOutput(actor, (e) => outputs.push(e.type));
    return { actor, outputs };
  }

  test("opening emits sheetOpened and closing hides the sheet", () => {
    const { actor, outputs } = build(async () => [null, {}]);
    send(actor, "OPEN");
    expect(actor.snapshot().path[0]).toBe("open");
    expect(outputs).toEqual(["SHEET_OPENED"]);
    send(actor, "CLOSE");
    expect(actor.snapshot().path[0]).toBe("closed");
  });

  test("removed returns to the open sheet", async () => {
    const removeMember = vi.fn().mockResolvedValue([null, {}]);
    const { actor } = build(removeMember);
    send(actor, "OPEN");
    send(actor, "REMOVE_MEMBER", { folderId: "f1", memberKey: "k1" });
    expect(actor.snapshot().path[0]).toBe("removing");
    await vi.waitFor(() => expect(actor.snapshot().path[0]).toBe("open"));
    expect(removeMember).toHaveBeenCalledWith("f1", "k1");
    expect(actor.snapshot().context.error).toBeNull();
  });

  test("removeFailed keeps the sheet open with the error, and reopening clears it", async () => {
    const { actor } = build(async () => [new Error("not the Admin"), null]);
    send(actor, "OPEN");
    send(actor, "REMOVE_MEMBER", { folderId: "f1", memberKey: "k1" });
    await vi.waitFor(() => expect(actor.snapshot().context.error).toBe("not the Admin"));
    expect(actor.snapshot().path[0]).toBe("open");
    send(actor, "CLOSE");
    send(actor, "OPEN");
    expect(actor.snapshot().context.error).toBeNull();
  });

  test("a rejected removal is a failure, not a crash", async () => {
    const { actor } = build(() => Promise.reject(new Error("offline")));
    send(actor, "OPEN");
    send(actor, "REMOVE_MEMBER", { folderId: "f1", memberKey: "k1" });
    await vi.waitFor(() => expect(actor.snapshot().context.error).toBe("offline"));
  });

  test("closing while removing is ignored", () => {
    const { actor } = build(() => new Promise(() => {}));
    send(actor, "OPEN");
    send(actor, "REMOVE_MEMBER", { folderId: "f1", memberKey: "k1" });
    send(actor, "CLOSE");
    expect(actor.snapshot().path[0]).toBe("removing");
  });
});
