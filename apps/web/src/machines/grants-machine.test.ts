import { describe, expect, test, vi, beforeEach } from "vite-plus/test";
import { $grantsRecords, $grantsDue, $grantsState, $grantsError, grants } from "./grants-machine";
import { gateway } from "../gateway";

const mock = gateway as any;

vi.mock("../gateway", () => {
  const g = {
    list: vi.fn(),
    add: vi.fn(),
    addFile: vi.fn(),
    remove: vi.fn(),
    join: vi.fn(),
    enroll: vi.fn(),
    status: vi.fn(),
    folders: vi.fn(),
    createFolder: vi.fn(),
    setActive: vi.fn(),
    setName: vi.fn(),
    requests: vi.fn(),
    respond: vi.fn(),
    logs: { view: vi.fn(), clear: vi.fn() },
    grants: { view: vi.fn(), grant: vi.fn(), decline: vi.fn(), snooze: vi.fn() },
  };
  return { gateway: g };
});

const record = (peerId: string, over: Record<string, unknown> = {}) => ({
  peerId,
  serveTo: "undecided" as const,
  lastChangedAt: 0,
  ...over,
});

beforeEach(() => {
  mock.grants.view.mockReset().mockResolvedValue([null, { records: [], due: [] }]);
  mock.grants.grant.mockReset().mockResolvedValue([null, { record: record("p1") }]);
  mock.grants.decline.mockReset().mockResolvedValue([null, { record: record("p1") }]);
  mock.grants.snooze.mockReset().mockResolvedValue([null, { snoozed: 1 }]);
  $grantsRecords.set([]);
  $grantsDue.set([]);
  $grantsError.set(null);
});

describe("grants machine", () => {
  test("refresh loads the ledger records and due prompts", async () => {
    mock.grants.view.mockResolvedValue([
      null,
      { records: [record("p1", { unknownHolderSince: 1 })], due: ["p1"] },
    ]);
    grants.refresh();
    await vi.waitFor(() => expect($grantsState.get()).toBe("ok"));
    expect($grantsRecords.get().map((r) => r.peerId)).toEqual(["p1"]);
    expect($grantsDue.get()).toEqual(["p1"]);
  });

  test("grant acts then refreshes to the new state", async () => {
    mock.grants.view
      .mockResolvedValueOnce([null, { records: [record("p1")], due: ["p1"] }])
      .mockResolvedValueOnce([null, { records: [record("p1", { serveTo: "granted" })], due: [] }]);
    grants.refresh();
    await vi.waitFor(() => expect($grantsState.get()).toBe("ok"));

    grants.grant("p1");
    await vi.waitFor(() => expect($grantsState.get()).toBe("ok"));
    expect($grantsRecords.get()[0].serveTo).toBe("granted");
    expect($grantsDue.get()).toEqual([]);
  });

  test("decline marks the peer terminal and clears it from due", async () => {
    mock.grants.view
      .mockResolvedValueOnce([null, { records: [record("p1")], due: ["p1"] }])
      .mockResolvedValueOnce([
        null,
        { records: [record("p1", { serveTo: "declined", declinedTerminal: true })], due: [] },
      ]);
    grants.refresh();
    await vi.waitFor(() => expect($grantsState.get()).toBe("ok"));

    grants.decline("p1");
    await vi.waitFor(() => expect($grantsState.get()).toBe("ok"));
    expect($grantsRecords.get()[0].serveTo).toBe("declined");
    expect($grantsRecords.get()[0].declinedTerminal).toBe(true);
  });

  test("snooze dismisses every due prompt for the day", async () => {
    mock.grants.view
      .mockResolvedValueOnce([null, { records: [record("p1")], due: ["p1"] }])
      .mockResolvedValueOnce([null, { records: [record("p1")], due: [] }]);
    grants.refresh();
    await vi.waitFor(() => expect($grantsState.get()).toBe("ok"));

    grants.snooze();
    await vi.waitFor(() => expect($grantsState.get()).toBe("ok"));
    expect(mock.grants.snooze).toHaveBeenCalledOnce();
    expect($grantsDue.get()).toEqual([]);
  });

  test("a view failure surfaces an error without an unhandled rejection", async () => {
    mock.grants.view.mockResolvedValue([new Error("ledger unreachable"), null]);
    grants.refresh();
    await vi.waitFor(() => expect($grantsState.get()).toBe("error"));
    expect($grantsError.get()).toContain("ledger unreachable");
  });
});
