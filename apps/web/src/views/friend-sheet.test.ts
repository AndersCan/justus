// @vitest-environment happy-dom
import { describe, expect, test, vi } from "vite-plus/test";
import { render } from "lit-html";

const hoisted = vi.hoisted(() => ({ list: vi.fn(), rename: vi.fn() }));
vi.mock("./toast", () => ({ toast: vi.fn() }));
vi.mock("../gateway", () => ({
  gateway: {
    friends: { list: hoisted.list, add: vi.fn(), rename: hoisted.rename, remove: vi.fn() },
  },
}));

const BEN = "b".repeat(64);
const CAL = "c".repeat(64);

async function open(identity: string) {
  hoisted.list.mockResolvedValue([null, { friends: [{ identity: BEN, name: "Ben B" }] }]);
  vi.resetModules();
  const { friendSheetView } = await import("./friend-sheet");
  const { friendsActor, friends } = await import("../machines/friends-machine");
  await friendsActor.settled();
  friends.open({ identity, ownName: "Someone" });
  const host = document.createElement("div");
  render(friendSheetView(), host);
  return { host, friendsActor };
}

describe("friend sheet Rename", () => {
  test("a saved friend gets Rename as the primary button, and no Add", async () => {
    const { host } = await open(BEN);
    const primary = host.querySelector("[data-friend-primary]");
    expect(primary?.textContent?.trim()).toBe("Rename");
    expect(host.textContent).not.toContain("Add to friends");
  });

  test("someone who is not a friend gets Add to friends and no Rename", async () => {
    const { host } = await open(CAL);
    const primary = host.querySelector("[data-friend-primary]");
    expect(primary?.textContent?.trim()).toBe("Add to friends");
    expect(host.textContent).not.toContain("Rename");
  });

  test("tapping Rename opens the name field with the saved name", async () => {
    const { host, friendsActor } = await open(BEN);
    (host.querySelector("[data-friend-primary]") as HTMLButtonElement).click();
    await friendsActor.settled();
    const input = host.querySelector<HTMLInputElement>("[data-friend-name]");
    expect(input?.value).toBe("Ben B");
  });
});
