// @vitest-environment happy-dom
import { describe, expect, test, vi } from "vite-plus/test";

const hoisted = vi.hoisted(() => ({
  toast: vi.fn(),
  remove: vi.fn(),
  list: vi.fn(),
}));
vi.mock("./toast", () => ({ toast: hoisted.toast }));
vi.mock("../gateway", () => ({
  gateway: { friends: { list: hoisted.list, add: vi.fn(), remove: hoisted.remove } },
}));

const BEN = "b".repeat(64);

async function setup(removeResult: unknown) {
  hoisted.toast.mockReset();
  hoisted.list.mockResolvedValue([null, { friends: [{ identity: BEN, name: "Ben" }] }]);
  hoisted.remove.mockResolvedValue(removeResult);
  vi.resetModules();
  await import("./friend-sheet");
  const { friendsActor, friends } = await import("../machines/friends-machine");
  await friendsActor.settled();
  friends.remove(BEN);
  await friendsActor.settled();
}

describe("friend sheet toasts", () => {
  test("a removed friend is announced by name", async () => {
    await setup([null, { removed: true }]);
    expect(hoisted.toast).toHaveBeenCalledWith("Removed Ben from friends");
  });

  test("a failed removal says so by name", async () => {
    await setup([{ message: "boom" }, null]);
    expect(hoisted.toast).toHaveBeenCalledWith("Couldn't remove Ben. Try again.");
  });
});
