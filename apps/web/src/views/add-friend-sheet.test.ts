// @vitest-environment happy-dom
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { render } from "lit-html";
import type { FolderSummary } from "@justus/core";
import { friends, friendsActor } from "../machines/friends-machine";
import { addFriend } from "../machines/sharing/add-friend";
import { addFriendSheetView } from "./add-friend-sheet";
import { invitePanel } from "./invite";

vi.mock("../gateway", () => ({
  gateway: {
    friends: {
      list: async () => [null, { friends: [] }],
      add: async (identity: string, name: string) => [null, { friend: { identity, name } }],
    },
    offerAlbum: vi.fn(async () => [null, {}]),
    turnOffInvite: vi.fn(),
  },
}));

const folder = (role: string) =>
  ({
    id: "f1",
    name: "Lisbon trip",
    role,
    invite: { code: "c", owner: "o" },
  }) as unknown as FolderSummary;

const mount = (role: string) => {
  const host = document.createElement("div");
  document.body.append(host);
  render([invitePanel(folder(role), "Nils", "Nils", false, () => {}), addFriendSheetView()], host);
  return host;
};

const button = (host: HTMLElement, text: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);

beforeEach(() => {
  document.body.replaceChildren();
  addFriend.closePicker();
});

describe("add a friend", () => {
  test("the Admin sees Add a friend above Or send a link", () => {
    const host = mount("creator");
    expect(button(host, "Add a friend")).toBeTruthy();
    expect(host.textContent).toContain("Or send a link");
  });

  test("a member sees neither", () => {
    const host = mount("member");
    expect(button(host, "Add a friend")).toBeUndefined();
    expect(host.textContent).not.toContain("Or send a link");
  });

  test("no friends shows No friends yet; focus moves in, Escape on it closes and focus returns", async () => {
    const host = mount("creator");
    const add = button(host, "Add a friend")!;
    add.focus();
    add.click();
    await vi.waitFor(() => expect(host.textContent).toContain("No friends yet"));
    expect(host.textContent).toContain("Tap someone in People");
    await vi.waitFor(() => expect(document.activeElement).toBe(button(host, "Close")));
    document.activeElement!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await vi.waitFor(() => expect(host.querySelector("[role=dialog]")).toBeNull());
    await Promise.resolve();
    expect(document.activeElement).toBe(add);
  });

  test("every friend already a member shows No friends yet", async () => {
    const host = mount("creator");
    addFriend.openPicker({
      folderId: "f1",
      albumName: "Lisbon trip",
      friends: [{ identity: "i1", name: "Kari" }],
      memberIdentities: ["i1"],
    });
    await vi.waitFor(() => expect(host.textContent).toContain("No friends yet"));
  });

  test("a saved friend is listed and picking asks them", async () => {
    const { gateway } = await import("../gateway");
    vi.mocked(gateway.offerAlbum).mockResolvedValue([null, { ok: true }]);
    const host = mount("creator");
    await vi.waitFor(() => expect(friendsActor.snapshot().path[0]).toBe("friendSheetClosed"));
    friends.open({ identity: "i1", ownName: "Kari" });
    friends.add();
    friends.type("Kari");
    friends.save();
    await vi.waitFor(() => expect(friendsActor.snapshot().context.friends).toEqual({ i1: "Kari" }));
    button(host, "Add a friend")!.click();
    await vi.waitFor(() => expect(button(host, "Kari")).toBeTruthy());
    button(host, "Kari")!.click();
    await vi.waitFor(() => expect(gateway.offerAlbum).toHaveBeenCalledWith("f1", "i1"));
  });

  test("backdrop click is ignored while asking", async () => {
    const { gateway } = await import("../gateway");
    vi.mocked(gateway.offerAlbum).mockReturnValue(new Promise(() => {}));
    const host = mount("creator");
    addFriend.openPicker({
      folderId: "f1",
      albumName: "Lisbon trip",
      friends: [{ identity: "i1", name: "Kari" }],
      memberIdentities: [],
    });
    await vi.waitFor(() => expect(button(host, "Kari")).toBeTruthy());
    button(host, "Kari")!.click();
    await vi.waitFor(() => expect(host.textContent).toContain("Asking Kari"));
    (host.querySelector("[role=dialog]")!.parentElement as HTMLElement).click();
    expect(host.querySelector("[role=dialog]")).not.toBeNull();
  });
});
