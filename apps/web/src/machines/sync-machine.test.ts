import { describe, expect, test, vi } from "vite-plus/test";
import { VirtualClock } from "@mantaq/core";
import type { SyncStatus } from "@justus/core";
import { gateway } from "../gateway";
import { createSyncActor, sync, syncActor, syncViewModel } from "./sync-machine";

vi.mock("../gateway", () => ({
  gateway: {
    status: vi.fn().mockResolvedValue([null, null]),
    join: vi.fn(),
    enroll: vi.fn(),
    logs: { view: vi.fn(), clear: vi.fn() },
  },
}));

const statusOf = (pending = false, name = "Ana") =>
  ({ name, folder: { id: "f1", role: "reader", pending } }) as unknown as SyncStatus;

const send = (actor: ReturnType<typeof createSyncActor>, type: string, payload?: unknown) =>
  (actor as any).send({ type, payload });

function build(port: { status?: any; join?: any; enroll?: any }) {
  const gateway = {
    status: vi.fn().mockResolvedValue([null, statusOf()]),
    join: vi.fn().mockResolvedValue([null, statusOf()]),
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
    expect(stateOf(actor)).toBe("refreshing");
    await vi.waitFor(() => expect(stateOf(actor)).toBe("ok"));
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
    await vi.waitFor(() => expect(stateOf(actor)).toBe("error"));
    expect(ctx(actor).error).toBe("offline");
    send(actor, "RETRY");
    expect(stateOf(actor)).toBe("refreshing");
    expect(ctx(actor).error).toBeNull();
    await vi.waitFor(() => expect(stateOf(actor)).toBe("ok"));
  });

  test("join waits for approval when the folder is pending", async () => {
    const pending = statusOf(true);
    const { actor, gateway } = build({ join: vi.fn().mockResolvedValue([null, pending]) });
    send(actor, "REFRESH");
    await vi.waitFor(() => expect(stateOf(actor)).toBe("ok"));
    send(actor, "JOIN", { key: "k1", name: "Ana" });
    expect(stateOf(actor)).toBe("joining");
    await vi.waitFor(() => expect(stateOf(actor)).toBe("ok"));
    expect(gateway.join).toHaveBeenCalledWith("k1", "Ana");
    expect(ctx(actor).awaitingApproval).toBe(true);
    expect(ctx(actor).status).toEqual(pending);
    expect(ctx(actor).pendingJoin).toBeNull();
  });

  test("join into a ready folder is not awaiting approval", async () => {
    const { actor } = build({});
    send(actor, "REFRESH");
    await vi.waitFor(() => expect(stateOf(actor)).toBe("ok"));
    send(actor, "JOIN", { key: "k1" });
    await vi.waitFor(() => expect(ctx(actor).status?.folder.id).toBe("f1"));
    expect(ctx(actor).awaitingApproval).toBe(false);
  });

  test("a failed join keeps the earlier status and shows the error", async () => {
    const { actor } = build({ join: vi.fn().mockResolvedValue([new Error("bad key"), null]) });
    send(actor, "REFRESH");
    await vi.waitFor(() => expect(stateOf(actor)).toBe("ok"));
    const before = ctx(actor).status;
    send(actor, "JOIN", { key: "nope" });
    await vi.waitFor(() => expect(ctx(actor).error).toBe("bad key"));
    expect(stateOf(actor)).toBe("ok");
    expect(ctx(actor).status).toEqual(before);
  });

  test("enroll stores the new status", async () => {
    const enrolled = statusOf();
    const { actor, gateway } = build({ enroll: vi.fn().mockResolvedValue([null, enrolled]) });
    send(actor, "REFRESH");
    await vi.waitFor(() => expect(stateOf(actor)).toBe("ok"));
    send(actor, "ENROLL", { key: "k2", name: "Trip" });
    expect(stateOf(actor)).toBe("enrolling");
    await vi.waitFor(() => expect(ctx(actor).status).toEqual(enrolled));
    expect(gateway.enroll).toHaveBeenCalledWith("k2", "Trip");
    expect(stateOf(actor)).toBe("ok");
  });

  test("a failed enroll shows the error", async () => {
    const { actor } = build({ enroll: vi.fn().mockResolvedValue([new Error("denied"), null]) });
    send(actor, "REFRESH");
    await vi.waitFor(() => expect(stateOf(actor)).toBe("ok"));
    send(actor, "ENROLL", { key: "k2", name: "Trip" });
    await vi.waitFor(() => expect(ctx(actor).error).toBe("denied"));
    expect(stateOf(actor)).toBe("ok");
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
    expect(stateOf(actor)).toBe("idle");
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
      state: "idle",
      busy: false,
      error: null,
      fatal: false,
    });
  });

  test("syncViewModel: busy while joining", async () => {
    const { actor } = build({ join: vi.fn(() => new Promise(() => {})) });
    send(actor, "REFRESH");
    await vi.waitFor(() => expect(stateOf(actor)).toBe("ok"));
    send(actor, "JOIN", { key: "k" });
    const vm = syncViewModel(actor.snapshot());
    expect(vm.state).toBe("joining");
    expect(vm.busy).toBe(true);
  });

  test("syncViewModel: a fatal error replaces the context error", () => {
    const vm = syncViewModel({
      path: ["__error"],
      context: { status: null, error: "old" },
      error: { error: new Error("boom"), reason: "throw" },
    } as any);
    expect(vm.fatal).toBe(true);
    expect(vm.state).toBe("error");
    expect(vm.error).toContain("boom");
  });
});
