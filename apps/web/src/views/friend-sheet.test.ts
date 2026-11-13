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

  test("Escape while saving keeps the sheet and the draft", async () => {
    hoisted.rename.mockReturnValue(new Promise(() => {}));
    const { host, friendsActor } = await open(BEN);
    document.body.append(host);
    (host.querySelector("[data-friend-primary]") as HTMLButtonElement).click();
    await friendsActor.settled();
    const input = host.querySelector<HTMLInputElement>("[data-friend-name]")!;
    input.value = "Benny";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await friendsActor.settled();
    (host.querySelector(".ui-btn-primary:not([disabled])") as HTMLButtonElement).click();
    await vi.waitFor(() =>
      expect(host.querySelector("[data-friend-name]")?.hasAttribute("disabled")).toBe(true),
    );
    host.querySelector("dialog")!.dispatchEvent(new Event("cancel", { cancelable: true }));
    await Promise.resolve();
    expect(host.querySelector("dialog")).not.toBeNull();
    expect(host.querySelector<HTMLInputElement>("[data-friend-name]")?.value).toBe("Benny");
    host.remove();
  });
});

describe("friend sheet as a dialog", () => {
  async function openFrom(identity = BEN) {
    hoisted.list.mockResolvedValue([null, { friends: [{ identity: BEN, name: "Ben B" }] }]);
    vi.resetModules();
    const { friendSheetView, rememberFocus } = await import("./friend-sheet");
    const { friendsActor, friends } = await import("../machines/friends-machine");
    await friendsActor.settled();
    // A tap on a phone does not focus the row: the row is not the focused element.
    const row = document.createElement("button");
    document.body.append(row);
    rememberFocus(row);
    friends.open({ identity, ownName: "Someone" });
    const host = document.createElement("div");
    document.body.append(host);
    render(friendSheetView(), host);
    await Promise.resolve();
    await Promise.resolve();
    return { host, row, friendsActor };
  }
  const cancel = (host: HTMLElement) =>
    host.querySelector("dialog")!.dispatchEvent(new Event("cancel", { cancelable: true }));
  const tapOutside = (host: HTMLElement) => {
    const d = host.querySelector("dialog")!;
    d.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    d.dispatchEvent(new Event("click", { bubbles: true }));
  };

  test("opens with focus on the primary button", async () => {
    const { host } = await openFrom();
    expect(document.activeElement).toBe(host.querySelector("[data-friend-primary]"));
    document.body.replaceChildren();
  });

  test("for someone who is not a friend, opens with focus on Add to friends", async () => {
    const { host } = await openFrom(CAL);
    const primary = host.querySelector("[data-friend-primary]");
    expect(primary?.textContent?.trim()).toBe("Add to friends");
    expect(document.activeElement).toBe(primary);
    document.body.replaceChildren();
  });

  test("Escape closes it and focus goes back to the row that opened it", async () => {
    const { host, row, friendsActor } = await openFrom();
    cancel(host);
    await friendsActor.settled();
    await vi.waitFor(() => expect(host.querySelector("dialog")).toBeNull());
    await Promise.resolve();
    expect(document.activeElement).toBe(row);
    document.body.replaceChildren();
  });

  test("Rename puts focus in the name field with the name selected", async () => {
    const { host, friendsActor } = await openFrom();
    (host.querySelector("[data-friend-primary]") as HTMLButtonElement).click();
    await friendsActor.settled();
    await Promise.resolve();
    const input = host.querySelector<HTMLInputElement>("[data-friend-name]")!;
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, "Ben B".length]);
    document.body.replaceChildren();
  });

  test("a tap outside while naming closes it and drops the draft", async () => {
    const { host, friendsActor } = await openFrom();
    (host.querySelector("[data-friend-primary]") as HTMLButtonElement).click();
    await friendsActor.settled();
    tapOutside(host);
    await friendsActor.settled();
    await vi.waitFor(() => expect(host.querySelector("dialog")).toBeNull());
    document.body.replaceChildren();
  });

  test("a failed save puts focus back in the name field", async () => {
    let fail: (v: unknown) => void = () => {};
    hoisted.rename.mockReturnValue(new Promise((r) => (fail = r)));
    const { host, friendsActor } = await openFrom();
    (host.querySelector("[data-friend-primary]") as HTMLButtonElement).click();
    await friendsActor.settled();
    const input = host.querySelector<HTMLInputElement>("[data-friend-name]")!;
    input.value = "Benny";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await friendsActor.settled();
    (host.querySelector(".ui-btn-primary:not([disabled])") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(input.disabled).toBe(true));
    // Browsers drop focus from a control that becomes disabled.
    const sink = document.createElement("button");
    document.body.append(sink);
    sink.focus();
    sink.remove();
    expect(input.contains(document.activeElement)).toBe(false);
    fail([{ code: "X", message: "disk full" }, null]);
    await friendsActor.settled();
    await vi.waitFor(() => expect(input.disabled).toBe(false));
    await Promise.resolve();
    expect(document.activeElement).toBe(host.querySelector("[data-friend-name]"));
    document.body.replaceChildren();
  });
});
