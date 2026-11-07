import { describe, expect, test, vi } from "vite-plus/test";
import { VirtualClock } from "@mantaq/core";
import type { GrantRecord } from "@justus/core";
import { createGrantsActor, grantsViewModel } from "./grants-machine";

vi.mock("../gateway", () => ({
  gateway: { logs: { view: vi.fn(), clear: vi.fn() } },
}));

const record = (peerId: string, over: Record<string, unknown> = {}) =>
  ({ peerId, serveTo: "undecided", lastChangedAt: 0, ...over }) as unknown as GrantRecord;

const refresh = () => ({ type: "REFRESH" }) as never;
const retry = () => ({ type: "RETRY" }) as never;
const act = (peerId: string, kind: "grant" | "decline" | "snooze" | "revoke") =>
  ({ type: "ACT", payload: { peerId, kind } }) as never;

type Reply = () => Promise<[unknown, unknown]>;

function setup(options: { view?: Reply; act?: Reply } = {}) {
  const done: Reply = async () => [null, { ok: true }];
  const port = {
    grants: {
      view: vi.fn(options.view ?? (async () => [null, { records: [record("p1")], due: ["p1"] }])),
      grant: vi.fn(options.act ?? done),
      decline: vi.fn(options.act ?? done),
      revoke: vi.fn(options.act ?? done),
      snooze: vi.fn(options.act ?? done),
    },
  };
  const actor = createGrantsActor({ clock: VirtualClock(), gateway: port as never });
  return { actor, port };
}

describe("grants machine factory", () => {
  test("refresh loads the records and due prompts", async () => {
    const { actor } = setup();
    actor.send(refresh());
    expect(actor.state.name).toBe("loadingShareList");
    await actor.settled();
    expect(actor.state.name).toBe("showingShareList");
    expect(actor.snapshot().context.records.map((r) => r.peerId)).toEqual(["p1"]);
    expect(actor.snapshot().context.due).toEqual(["p1"]);
  });

  test("a failed refresh shows the error", async () => {
    const { actor } = setup({ view: async () => [new Error("ledger unreachable"), null] });
    actor.send(refresh());
    await actor.settled();
    expect(actor.state.name).toBe("couldNotLoadShareList");
    expect(actor.snapshot().context.error).toBe("ledger unreachable");
  });

  test.each([
    ["grant", "grant", ["p1"]],
    ["decline", "decline", ["p1"]],
    ["revoke", "revoke", ["p1"]],
    ["snooze", "snooze", []],
  ] as const)("%s calls the %s port method and reloads", async (kind, method, args) => {
    const { actor, port } = setup();
    actor.send(refresh());
    await actor.settled();
    actor.send(act("p1", kind));
    expect(actor.state.name).toBe("savingShareChoice");
    await actor.settled();
    expect(actor.state.name).toBe("showingShareList");
    expect(port.grants[method]).toHaveBeenCalledWith(...args);
    expect(port.grants.view).toHaveBeenCalledTimes(2);
  });

  test("a failed act shows the error and keeps the list", async () => {
    const { actor } = setup({ act: async () => [new Error("disk full"), null] });
    actor.send(refresh());
    await actor.settled();
    actor.send(act("p1", "grant"));
    await actor.settled();
    expect(actor.state.name).toBe("couldNotSaveShareChoice");
    expect(actor.snapshot().context.error).toBe("disk full");
    expect(actor.snapshot().context.records.map((r) => r.peerId)).toEqual(["p1"]);
    expect(grantsViewModel(actor.snapshot()).settled).toBe(true);
  });

  test("from couldNotSaveShareChoice, ACT saves again and REFRESH reloads", async () => {
    const { actor } = setup({ act: async () => [new Error("disk full"), null] });
    actor.send(refresh());
    await actor.settled();
    actor.send(act("p1", "grant"));
    await actor.settled();
    actor.send(act("p1", "grant"));
    expect(actor.state.name).toBe("savingShareChoice");
    expect(actor.snapshot().context.error).toBeNull();
    await actor.settled();
    expect(actor.state.name).toBe("couldNotSaveShareChoice");
    actor.send(refresh());
    expect(actor.state.name).toBe("loadingShareList");
    await actor.settled();
    expect(actor.state.name).toBe("showingShareList");
  });

  test("retry clears the error and loads again", async () => {
    let calls = 0;
    const { actor } = setup({
      view: async () =>
        ++calls === 1 ? [new Error("offline"), null] : [null, { records: [], due: [] }],
    });
    actor.send(refresh());
    await actor.settled();
    expect(actor.state.name).toBe("couldNotLoadShareList");
    actor.send(retry());
    expect(actor.snapshot().context.error).toBeNull();
    await actor.settled();
    expect(actor.state.name).toBe("showingShareList");
  });
});

describe("grantsViewModel", () => {
  test("initial snapshot", () => {
    const { actor } = setup();
    expect(grantsViewModel(actor.snapshot())).toEqual({
      records: [],
      due: [],
      dueRecords: [],
      state: "shareListNotLoaded",
      acting: false,
      settled: false,
      error: null,
      fatal: false,
    });
  });

  test("loaded records, due records and acting", async () => {
    const { actor } = setup({ act: () => new Promise(() => {}) });
    actor.send(refresh());
    await actor.settled();
    expect(grantsViewModel(actor.snapshot()).dueRecords.map((r) => r.peerId)).toEqual(["p1"]);
    actor.send(act("p1", "grant"));
    const vm = grantsViewModel(actor.snapshot());
    expect(vm.state).toBe("savingShareChoice");
    expect(vm.acting).toBe(true);
  });
});
