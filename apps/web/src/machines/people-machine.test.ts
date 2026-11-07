import { describe, expect, test, vi, beforeEach } from "vite-plus/test";
import { VirtualClock } from "@mantaq/core";
import { onOutput } from "@mantaq/sugar";
import { createPeopleActor, people, peopleActor, peopleViewModel } from "./people-machine";
import { gateway } from "../gateway";

const mock = gateway as any;

vi.mock("../gateway", () => ({
  gateway: {
    removeMember: vi.fn(),
    makeMember: vi.fn(),
    makeViewer: vi.fn(),
    requests: vi.fn().mockResolvedValue([null, { requests: [] }]),
    respond: vi.fn(),
    logs: { view: vi.fn(), clear: vi.fn() },
  },
}));

beforeEach(() => {
  mock.makeMember.mockReset().mockResolvedValue([null, { ok: true }]);
  mock.makeViewer.mockReset().mockResolvedValue([null, { ok: true }]);
  mock.removeMember.mockReset().mockResolvedValue([null, { ok: true }]);
  people.close();
});

describe("people machine", () => {
  test("opens and closes the sheet", () => {
    people.open();
    expect(peopleActor.snapshot().path[0]).toBe("showingPeople");
    people.close();
    expect(peopleActor.snapshot().path[0]).toBe("peopleSheetClosed");
  });

  test("the QR code shows once asked and hides when the sheet closes", () => {
    people.open();
    expect(peopleActor.snapshot().context.qrShown).toBe(false);
    people.showQr();
    expect(peopleActor.snapshot().context.qrShown).toBe(true);
    expect(peopleActor.snapshot().path[0]).toBe("showingPeople");
    people.close();
    expect(peopleActor.snapshot().context.qrShown).toBe(false);
    people.open();
    expect(peopleActor.snapshot().context.qrShown).toBe(false);
  });

  test("removing a member returns to the open sheet", async () => {
    people.open();
    people.remove("f1", "k1");
    await vi.waitFor(() => expect(peopleActor.snapshot().path[0]).toBe("showingPeople"));
    expect(mock.removeMember).toHaveBeenCalledWith("f1", "k1");
  });

  test("a failed removal keeps the sheet open with the error", async () => {
    mock.removeMember.mockResolvedValue([new Error("not the Admin"), null]);
    people.open();
    people.remove("f1", "k1");
    await vi.waitFor(() => expect(peopleActor.snapshot().context.error).toBe("not the Admin"));
    expect(peopleActor.snapshot().path[0]).toBe("couldNotRemoveMember");
  });
});

describe("letting a Viewer add photos", () => {
  test("success returns to the open sheet", async () => {
    people.open();
    people.letViewerAddPhotos("f1", "k1");
    await vi.waitFor(() => expect(peopleActor.snapshot().path[0]).toBe("showingPeople"));
    expect(mock.makeMember).toHaveBeenCalledWith("f1", "k1");
  });

  test("an already-enrolled error counts as success", async () => {
    mock.makeMember.mockResolvedValue([new Error("Member already enrolled"), null]);
    people.open();
    people.letViewerAddPhotos("f1", "k1");
    await vi.waitFor(() => expect(peopleActor.snapshot().path[0]).toBe("showingPeople"));
    expect(peopleActor.snapshot().context.error).toBeNull();
  });

  test("a failure keeps the sheet open with the error", async () => {
    mock.makeMember.mockResolvedValue([new Error("not the Admin"), null]);
    people.open();
    people.letViewerAddPhotos("f1", "k1");
    await vi.waitFor(() => expect(peopleActor.snapshot().context.error).toBe("not the Admin"));
    expect(peopleActor.snapshot().path[0]).toBe("couldNotLetViewerAddPhotos");
  });

  test("the view model is busy while saving", () => {
    const actor = createPeopleActor({
      clock: VirtualClock(),
      gateway: { makeMember: () => new Promise(() => {}) } as any,
    });
    actor.send({ type: "OPEN" } as never);
    actor.send({
      type: "LET_VIEWER_ADD_PHOTOS",
      payload: { folderId: "f1", memberKey: "k" },
    } as never);
    const vm = peopleViewModel(actor.snapshot(), { status: null, requests: [], friends: {} });
    expect(actor.snapshot().path[0]).toBe("lettingViewerAddPhotos");
    expect(vm.busy).toBe(true);
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
    expect(actor.snapshot().path[0]).toBe("showingPeople");
    expect(outputs).toEqual(["SHEET_OPENED"]);
    send(actor, "CLOSE");
    expect(actor.snapshot().path[0]).toBe("peopleSheetClosed");
  });

  test("removed returns to the open sheet", async () => {
    const removeMember = vi.fn().mockResolvedValue([null, {}]);
    const { actor } = build(removeMember);
    send(actor, "OPEN");
    send(actor, "REMOVE_MEMBER", { folderId: "f1", memberKey: "k1" });
    expect(actor.snapshot().path[0]).toBe("removingMember");
    await vi.waitFor(() => expect(actor.snapshot().path[0]).toBe("showingPeople"));
    expect(removeMember).toHaveBeenCalledWith("f1", "k1");
    expect(actor.snapshot().context.error).toBeNull();
  });

  test("removeFailed keeps the sheet open with the error, and reopening clears it", async () => {
    const { actor } = build(async () => [new Error("not the Admin"), null]);
    send(actor, "OPEN");
    send(actor, "REMOVE_MEMBER", { folderId: "f1", memberKey: "k1" });
    await vi.waitFor(() => expect(actor.snapshot().context.error).toBe("not the Admin"));
    expect(actor.snapshot().path[0]).toBe("couldNotRemoveMember");
    send(actor, "CLOSE");
    send(actor, "OPEN");
    expect(actor.snapshot().context.error).toBeNull();
  });

  test("from couldNotRemoveMember, QR shows and REMOVE_MEMBER tries again", async () => {
    const { actor } = build(async () => [new Error("not the Admin"), null]);
    send(actor, "OPEN");
    send(actor, "REMOVE_MEMBER", { folderId: "f1", memberKey: "k1" });
    await vi.waitFor(() => expect(actor.snapshot().path[0]).toBe("couldNotRemoveMember"));
    send(actor, "SHOW_QR");
    expect(actor.snapshot().context.qrShown).toBe(true);
    send(actor, "REMOVE_MEMBER", { folderId: "f1", memberKey: "k1" });
    expect(actor.snapshot().path[0]).toBe("removingMember");
    expect(actor.snapshot().context.error).toBeNull();
    await vi.waitFor(() => expect(actor.snapshot().path[0]).toBe("couldNotRemoveMember"));
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
    expect(actor.snapshot().path[0]).toBe("removingMember");
  });
});

describe("peopleViewModel", () => {
  const status = {
    name: "Ann",
    folder: { id: "f1", role: "creator" },
    members: [{ key: "me", name: "Ann", admin: true, connected: true }],
  } as any;
  const deps = { status, requests: [], friends: {} };

  test("closed, from the initial snapshot", () => {
    const actor = createPeopleActor({ clock: VirtualClock(), gateway: {} as any });
    const vm = peopleViewModel(actor.snapshot(), deps);
    expect(vm.open).toBe(false);
    expect(vm.busy).toBe(false);
    expect(vm.error).toBeNull();
    expect(vm.isAdmin).toBe(true);
    expect(vm.myName).toBe("Ann");
    expect(vm.folder).toBe(status.folder);
  });

  test("open, then removing, with no status", () => {
    const actor = createPeopleActor({
      clock: VirtualClock(),
      gateway: { removeMember: () => new Promise(() => {}) } as any,
    });
    actor.send({ type: "OPEN" } as never);
    expect(peopleViewModel(actor.snapshot(), { ...deps, status: null }).open).toBe(true);
    actor.send({ type: "REMOVE_MEMBER", payload: { folderId: "f1", memberKey: "k" } } as never);
    const vm = peopleViewModel(actor.snapshot(), { ...deps, status: null });
    expect(vm.busy).toBe(true);
    expect(vm.isAdmin).toBe(false);
    expect(vm.folder).toBeNull();
    expect(vm.myName).toBe("");
  });
});

describe("making a Collaborator a Viewer", () => {
  test("MAKE_VIEWER calls makeViewer and returns to the open sheet", async () => {
    people.open();
    people.makeViewer("f1", "k1");
    await vi.waitFor(() => expect(peopleActor.snapshot().path[0]).toBe("showingPeople"));
    expect(mock.makeViewer).toHaveBeenCalledWith("f1", "k1");
  });

  test("a failure lands in couldNotMakeViewer with the message", async () => {
    mock.makeViewer.mockResolvedValue([
      new Error("Only the Admin can make someone a Viewer"),
      null,
    ]);
    people.open();
    people.makeViewer("f1", "k1");
    await vi.waitFor(() =>
      expect(peopleActor.snapshot().context.error).toBe("Only the Admin can make someone a Viewer"),
    );
    expect(peopleActor.snapshot().path[0]).toBe("couldNotMakeViewer");
  });

  test("busy while makingViewer", () => {
    const actor = createPeopleActor({
      clock: VirtualClock(),
      gateway: { makeViewer: () => new Promise(() => {}) } as any,
    });
    actor.send({ type: "OPEN" } as never);
    actor.send({ type: "MAKE_VIEWER", payload: { folderId: "f1", memberKey: "k" } } as never);
    const vm = peopleViewModel(actor.snapshot(), { status: null, requests: [], friends: {} });
    expect(actor.snapshot().path[0]).toBe("makingViewer");
    expect(vm.busy).toBe(true);
  });
});
