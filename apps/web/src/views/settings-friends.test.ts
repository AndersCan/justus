// @vitest-environment happy-dom
import { render } from "lit-html";
import { VirtualClock } from "@mantaq/core";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { createFriendsActor, type FriendsPort } from "../machines/friends-machine";

const hoisted = vi.hoisted(() => ({ confirmAction: vi.fn() }));
vi.mock("../gateway", () => ({ gateway: { friends: {} } }));
vi.mock("./confirm", () => ({ confirmAction: hoisted.confirmAction }));

const { friendsSection } = await import("./settings");

const BEN = "b".repeat(64);
const SAM = "a".repeat(64);

async function mount(friends: { identity: string; name: string }[]) {
  const port = {
    list: vi.fn(async () => [null, { friends }]),
    add: vi.fn(),
    remove: vi.fn(async () => [null, { removed: true }]),
  };
  const actor = createFriendsActor({ clock: VirtualClock(), port: port as unknown as FriendsPort });
  const host = document.createElement("div");
  document.body.appendChild(host);
  render(
    friendsSection(actor, (identity) =>
      actor.send({ type: "REMOVE", payload: { identity } } as never),
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
    const labels = [...host.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"));
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
    host.querySelectorAll("button")[0].click();
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
    host.querySelectorAll("button")[0].click();
    await vi.waitFor(() => expect(hoisted.confirmAction).toHaveBeenCalled());
    await Promise.resolve();
    expect(port.remove).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Ben");
  });
});
