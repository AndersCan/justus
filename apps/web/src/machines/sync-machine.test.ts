import { describe, expect, test, vi } from "vite-plus/test";
import { VirtualClock } from "@mantaq/core";
import type { SyncStatus } from "@justus/core";
import { gateway } from "../gateway";
import { createSyncActor, sync, syncActor, syncViewModel } from "./sync-machine";

vi.mock("../gateway", () => ({
  gateway: {
    status: vi.fn().mockResolvedValue([null, null]),
    enroll: vi.fn(),
    logs: { view: vi.fn(), clear: vi.fn() },
  },
}));

const statusOf = (pending = false, name = "Ana") =>
  ({ name, folder: { id: "f1", role: "reader", pending } }) as unknown as SyncStatus;

const send = (actor: ReturnType<typeof createSyncActor>, type: string, payload?: unknown) =>
  (actor as any).send({ type, payload });

function build(port: { status?: any; enroll?: any }) {
  const gateway = {
    status: vi.fn().mockResolvedValue([null, statusOf()]),
    enroll: vi.fn().mockResolvedValue([null, statusOf()]),
    ...port,
  };
  const actor = createSyncActor({ clock: VirtualClock(), gateway: gateway as any });
  return { actor, gateway };
}

const stateOf = (actor: ReturnType<typeof createSyncActor>) => actor.snapshot().path[0];
const ctx = (actor: ReturnType<typeof createSyncActor>) => actor.snapshot().context;

describe("sync factory", () => {
  test("refresh stores the status", async () => {
    const status = statusOf();
    const { actor } = build({ status: vi.fn().mockResolvedValue([null, status]) });
    send(actor, "REFRESH");
    expect(stateOf(actor)).toBe("checkingAlbum");
    await vi.waitFor(() => expect(stateOf(actor)).toBe("showingAlbum"));
    expect(ctx(actor).status).toEqual(status);
    expect(ctx(actor).error).toBeNull();
  });

  test("a failed refresh shows the error and retry clears it", async () => {
    const status = vi
      .fn()
      .mockResolvedValueOnce([new Error("offline"), null])
      .mockResolvedValue([null, statusOf()]);
    const { actor } = build({ status });
    send(actor, "REFRESH");
    await vi.waitFor(() => expect(stateOf(actor)).toBe("couldNotCheckAlbum"));
    expect(ctx(actor).error).toBe("offline");
    send(actor, "RETRY");
    expect(stateOf(actor)).toBe("checkingAlbum");
    expect(ctx(actor).error).toBeNull();
    await vi.waitFor(() => expect(stateOf(actor)).toBe("showingAlbum"));
  });

  test("enroll stores the new status", async () => {
    const enrolled = statusOf();
    const { actor, gateway } = build({ enroll: vi.fn().mockResolvedValue([null, enrolled]) });
    send(actor, "REFRESH");
    await vi.waitFor(() => expect(stateOf(actor)).toBe("showingAlbum"));
    send(actor, "ENROLL", { key: "k2", name: "Trip" });
    expect(stateOf(actor)).toBe("addingMemberByKey");
    await vi.waitFor(() => expect(ctx(actor).status).toEqual(enrolled));
    expect(gateway.enroll).toHaveBeenCalledWith("k2", "Trip");
    expect(stateOf(actor)).toBe("showingAlbum");
  });

  test("a failed enroll lands in couldNotAddMember with the message", async () => {
    const { actor } = build({ enroll: vi.fn().mockResolvedValue([new Error("denied"), null]) });
    send(actor, "REFRESH");
    await vi.waitFor(() => expect(stateOf(actor)).toBe("showingAlbum"));
    send(actor, "ENROLL", { key: "k2", name: "Trip" });
    await vi.waitFor(() => expect(stateOf(actor)).toBe("couldNotAddMember"));
    expect(ctx(actor).error).toBe("denied");
  });

  test("from couldNotAddMember, ENROLL enters enrolling and clears the error; REFRESH reloads", async () => {
    const enroll = vi.fn().mockResolvedValue([new Error("denied"), null]);
    const { actor } = build({ enroll });
    send(actor, "REFRESH");
    await vi.waitFor(() => expect(stateOf(actor)).toBe("showingAlbum"));
    send(actor, "ENROLL", { key: "k2", name: "Trip" });
    await vi.waitFor(() => expect(stateOf(actor)).toBe("couldNotAddMember"));
    send(actor, "REFRESH");
    expect(stateOf(actor)).toBe("checkingAlbum");
    expect(ctx(actor).error).toBeNull();
    await vi.waitFor(() => expect(stateOf(actor)).toBe("showingAlbum"));
    send(actor, "ENROLL", { key: "k2", name: "Trip" });
    await vi.waitFor(() => expect(stateOf(actor)).toBe("couldNotAddMember"));
    send(actor, "ENROLL", { key: "k2", name: "Trip" });
    expect(stateOf(actor)).toBe("addingMemberByKey");
    expect(ctx(actor).error).toBeNull();
    await vi.waitFor(() => expect(stateOf(actor)).toBe("couldNotAddMember"));
  });

  test("a pending status lands in waitingForAdminApproval, a settled one in ok", async () => {
    const pending = build({ status: vi.fn().mockResolvedValue([null, statusOf(true)]) });
    send(pending.actor, "REFRESH");
    await vi.waitFor(() => expect(stateOf(pending.actor)).toBe("waitingForAdminApproval"));
    const fine = build({});
    send(fine.actor, "REFRESH");
    await vi.waitFor(() => expect(stateOf(fine.actor)).toBe("showingAlbum"));
  });

  test("waitingForAdminApproval accepts REFRESH and ENROLL", async () => {
    const { actor } = build({ status: vi.fn().mockResolvedValue([null, statusOf(true)]) });
    send(actor, "REFRESH");
    await vi.waitFor(() => expect(stateOf(actor)).toBe("waitingForAdminApproval"));
    send(actor, "REFRESH");
    expect(stateOf(actor)).toBe("checkingAlbum");
    await vi.waitFor(() => expect(stateOf(actor)).toBe("waitingForAdminApproval"));
    send(actor, "ENROLL", { key: "k", name: "T" });
    expect(stateOf(actor)).toBe("addingMemberByKey");
  });
});

describe("sync singleton", () => {
  test("a failed refresh keeps the last status and sets the error; retry clears it", async () => {
    const first = statusOf(false, "first");
    const after = statusOf(false, "after-retry");
    vi.mocked(gateway.status)
      .mockResolvedValueOnce([null, first] as any)
      .mockResolvedValueOnce([new Error("offline"), null] as any)
      .mockResolvedValueOnce([null, after] as any);
    sync.refresh();
    await vi.waitFor(() => expect(syncActor.snapshot().context.status).toEqual(first));
    sync.refresh();
    await vi.waitFor(() => expect(syncActor.snapshot().context.error).toBe("offline"));
    expect(syncActor.snapshot().context.status).toEqual(first);
    sync.retry();
    await vi.waitFor(() => expect(syncActor.snapshot().context.status).toEqual(after));
    expect(syncActor.snapshot().context.error).toBeNull();
  });
});

describe("sync single owner", () => {
  test("STATUS_SEEN sets the status in any state without leaving it", () => {
    const { actor } = build({});
    const status = statusOf(false, "Seen");
    send(actor, "STATUS_SEEN", { status });
    expect(ctx(actor).status).toBe(status);
    expect(stateOf(actor)).toBe("albumNotChecked");
  });

  test("STATUS_SEEN moves ok to waitingForAdminApproval and back", async () => {
    const { actor } = build({});
    send(actor, "REFRESH");
    await vi.waitFor(() => expect(stateOf(actor)).toBe("showingAlbum"));
    send(actor, "STATUS_SEEN", { status: statusOf(false) });
    expect(stateOf(actor)).toBe("showingAlbum");
    send(actor, "STATUS_SEEN", { status: statusOf(true) });
    expect(stateOf(actor)).toBe("waitingForAdminApproval");
    send(actor, "STATUS_SEEN", { status: statusOf(true) });
    expect(stateOf(actor)).toBe("waitingForAdminApproval");
    send(actor, "STATUS_SEEN", { status: statusOf(false) });
    expect(stateOf(actor)).toBe("showingAlbum");
  });

  test("STATUS_SEEN while refreshing only stores the status", () => {
    const { actor } = build({ status: vi.fn(() => new Promise(() => {})) });
    send(actor, "REFRESH");
    const status = statusOf(true);
    send(actor, "STATUS_SEEN", { status });
    expect(stateOf(actor)).toBe("checkingAlbum");
    expect(ctx(actor).status).toBe(status);
  });

  test("context.status keeps its identity across unrelated changes", async () => {
    const { actor } = build({ status: vi.fn().mockResolvedValue([new Error("offline"), null]) });
    const status = statusOf();
    send(actor, "STATUS_SEEN", { status });
    send(actor, "REFRESH");
    await actor.settled();
    expect(ctx(actor).error).toBe("offline");
    expect(ctx(actor).status).toBe(status);
  });

  test("syncViewModel: initial snapshot", () => {
    const { actor } = build({});
    expect(syncViewModel(actor.snapshot())).toEqual({
      status: null,
      state: "albumNotChecked",
      busy: false,
      settled: false,
      error: null,
      fatal: false,
    });
  });

  test("syncViewModel: busy while enrolling, settled in ok and waitingForAdminApproval", async () => {
    const { actor } = build({ enroll: vi.fn(() => new Promise(() => {})) });
    send(actor, "REFRESH");
    await vi.waitFor(() => expect(stateOf(actor)).toBe("showingAlbum"));
    expect(syncViewModel(actor.snapshot())).toMatchObject({ busy: false, settled: true });
    send(actor, "ENROLL", { key: "k", name: "T" });
    const vm = syncViewModel(actor.snapshot());
    expect(vm.state).toBe("addingMemberByKey");
    expect(vm).toMatchObject({ busy: true, settled: false });
    const waiting = build({ status: vi.fn().mockResolvedValue([null, statusOf(true)]) });
    send(waiting.actor, "REFRESH");
    await vi.waitFor(() => expect(stateOf(waiting.actor)).toBe("waitingForAdminApproval"));
    expect(syncViewModel(waiting.actor.snapshot())).toMatchObject({ busy: false, settled: true });
  });

  test("syncViewModel: a fatal error replaces the context error", () => {
    const vm = syncViewModel({
      path: ["__error"],
      context: { status: null, error: "old" },
      error: { error: new Error("boom"), reason: "throw" },
    } as any);
    expect(vm.fatal).toBe(true);
    expect(vm.state).toBe("__error");
    expect(vm.error).toContain("boom");
  });
});
