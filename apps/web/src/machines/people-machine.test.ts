import { describe, expect, test, vi, beforeEach } from "vite-plus/test";
import { $peopleError, $peopleState, people } from "./people-machine";
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
