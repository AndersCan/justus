// @vitest-environment happy-dom
import { html, render } from "lit-html";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { friendsMachine, type FriendsPort } from "../machines/friends-machine";

const hoisted = vi.hoisted(() => ({
  confirmAction: vi.fn(),
  gateway: { list: vi.fn(), words: vi.fn() },
}));
vi.mock("../gateway", () => ({ gateway: { friends: hoisted.gateway } }));
vi.mock("./confirm", () => ({ confirmAction: hoisted.confirmAction }));

const { friendsSection } = await import("./settings");

const BEN = "b".repeat(64);
const SAM = "a".repeat(64);

const removeButtons = (host: HTMLElement) => [
  ...host.querySelectorAll<HTMLButtonElement>("button[aria-label^='Remove']"),
];

async function mount(
  friends: { identity: string; name: string }[],
  open?: (t: { identity: string; ownName: string }) => void,
) {
  const port = {
    list: vi.fn(async () => [null, { friends }]),
    add: vi.fn(),
    words: vi.fn(async () => [null, { words: "early steel produce clap" }]),
    remove: vi.fn(async () => [null, { removed: true }]),
  };
  const actor = friendsMachine.create({ port: port as unknown as FriendsPort });
  const host = document.createElement("div");
  document.body.appendChild(host);
  render(
    friendsSection(
      actor,
      (identity) => actor.send({ type: "REMOVE", payload: { identity } } as never),
      open ?? ((target) => actor.send({ type: "OPEN", payload: { target } } as never)),
    ),
    host,
  );
  await actor.settled();
  return { host, port };
}

describe("Settings › Friends", () => {
  beforeEach(() => hoisted.confirmAction.mockReset());

  test("lists friends by name, each with a labelled Remove", async () => {
    const { host } = await mount([
      { identity: SAM, name: "Sam" },
      { identity: BEN, name: "Ben" },
    ]);
    const labels = [...host.querySelectorAll("button[aria-label^='Remove']")].map((b) =>
      b.getAttribute("aria-label"),
    );
    expect(labels).toEqual(["Remove Ben from friends", "Remove Sam from friends"]);
    expect(host.textContent).not.toContain("No friends yet");
  });

  test("with no friends it says how to save one", async () => {
    const { host } = await mount([]);
    expect(host.textContent).toContain("No friends yet.");
    expect(host.querySelectorAll("button")).toHaveLength(0);
  });

  test("a confirmed Remove removes that friend and the row goes", async () => {
    hoisted.confirmAction.mockResolvedValue(true);
    const { host, port } = await mount([
      { identity: SAM, name: "Sam" },
      { identity: BEN, name: "Ben" },
    ]);
    removeButtons(host)[0].click();
    await vi.waitFor(() => expect(port.remove).toHaveBeenCalledWith(BEN));
    await vi.waitFor(() => expect(host.textContent).not.toContain("Ben"));
    expect(hoisted.confirmAction.mock.calls[0][0]).toMatchObject({
      title: "Remove Ben from friends?",
      tone: "danger",
    });
  });

  test("keeping the friend removes nothing", async () => {
    hoisted.confirmAction.mockResolvedValue(false);
    const { host, port } = await mount([{ identity: BEN, name: "Ben" }]);
    removeButtons(host)[0].click();
    await vi.waitFor(() => expect(hoisted.confirmAction).toHaveBeenCalled());
    await Promise.resolve();
    expect(port.remove).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Ben");
  });
});

describe("Settings › Friends while removing", () => {
  test("Remove buttons are disabled until the removal finishes", async () => {
    hoisted.confirmAction.mockResolvedValue(true);
    let finish: (v: unknown) => void = () => {};
    const { host, port } = await mount([
      { identity: SAM, name: "Sam" },
      { identity: BEN, name: "Ben" },
    ]);
    port.remove.mockImplementation(() => new Promise((r) => (finish = r)) as never);
    removeButtons(host)[0].click();
    await vi.waitFor(() =>
      expect([...host.querySelectorAll("button")].every((b) => b.disabled)).toBe(true),
    );
    finish([null, { removed: true }]);
    await vi.waitFor(() => expect(host.textContent).not.toContain("Ben"));
    expect([...host.querySelectorAll("button")].every((b) => !b.disabled)).toBe(true);
  });
});

describe("Settings › Friends open the sheet", () => {
  test("tapping a name calls open with that friend", async () => {
    const open = vi.fn();
    const { host } = await mount([{ identity: SAM, name: "Sam" }], open);
    host.querySelector<HTMLButtonElement>("[data-friend-open]")!.click();
    expect(open).toHaveBeenCalledWith({ identity: SAM, ownName: "Sam" });
  });

  test("the sheet opens titled with the name and Close returns focus to it", async () => {
    hoisted.gateway.list.mockResolvedValue([null, { friends: [{ identity: SAM, name: "Sam" }] }]);
    hoisted.gateway.words.mockResolvedValue([null, { words: "early steel produce clap" }]);
    vi.resetModules();
    const { friendsSection } = await import("./settings");
    const { friendSheetView } = await import("./friend-sheet");
    const { friendsActor } = await import("../machines/friends-machine");
    await friendsActor.settled();
    const host = document.createElement("div");
    document.body.append(host);
    render(html`${friendsSection()}${friendSheetView()}`, host);
    const sam = host.querySelector<HTMLButtonElement>("[data-friend-open]")!;
    sam.focus();
    sam.click();
    await vi.waitFor(() =>
      expect(host.querySelector("[data-friend-words]")?.textContent).toBe(
        "early steel produce clap",
      ),
    );
    expect(host.querySelector("dialog")!.textContent).toContain("Sam");
    host.querySelector<HTMLButtonElement>("dialog [data-dismiss]")!.click();
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(host.querySelector("[data-friend-open]")),
    );
  });

  test("name buttons are disabled while removing", async () => {
    hoisted.confirmAction.mockResolvedValue(true);
    const { host, port } = await mount([{ identity: SAM, name: "Sam" }]);
    port.remove.mockImplementation(() => new Promise(() => {}) as never);
    removeButtons(host)[0].click();
    await vi.waitFor(() =>
      expect(host.querySelector<HTMLButtonElement>("[data-friend-open]")!.disabled).toBe(true),
    );
  });
});
