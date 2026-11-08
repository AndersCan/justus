// @vitest-environment happy-dom
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { render } from "lit-html";
import type { FolderSummary } from "@justus/core";
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
    saveInviteLink: vi.fn(async () => [null, { ok: true }]),
  },
}));

const folder = (role: string) =>
  ({
    id: "f1",
    name: "Lisbon trip",
    role,
    invite: { code: "c", owner: "o" },
  }) as unknown as FolderSummary;

const mount = (
  role: string,
  saved: Record<string, string> = {},
  memberIdentities: string[] = [],
) => {
  const host = document.createElement("div");
  document.body.append(host);
  render(
    [
      invitePanel(folder(role), "Nils", "Nils", false, () => {}, memberIdentities, saved),
      addFriendSheetView(),
    ],
    host,
  );
  return host;
};

const button = (host: HTMLElement, text: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);

const primaries = (h: HTMLElement) =>
  [...h.querySelectorAll(".ui-btn-primary")].map((b) => b.textContent!.trim());

beforeEach(() => {
  document.body.replaceChildren();
  addFriend.closePicker();
});

describe("add a friend", () => {
  test("no saved friends: no Add a friend button and no 'Or send a link'", () => {
    const host = mount("creator");
    expect(button(host, "Add a friend")).toBeUndefined();
    expect(host.textContent).not.toContain("Or send a link");
  });

  test("every friend already a member: no Add a friend button", () => {
    const host = mount("creator", { i1: "Kari" }, ["i1"]);
    expect(button(host, "Add a friend")).toBeUndefined();
  });

  test("one friend: Add a friend and the friend's name", () => {
    const host = mount("creator", { i1: "Kari" });
    expect(button(host, "Add a friend")).toBeTruthy();
    expect(host.textContent).toContain(
      "From your friends: Kari. They get the invite in Justus, no link needed.",
    );
    expect(host.textContent).toContain("Or send a link");
  });

  test("a friend to add: Add a friend is the only coloured button", () => {
    const host = mount("creator", { i1: "Kari" });
    expect(primaries(host)).toEqual(["Add a friend"]);
    expect(button(host, "Copy invite link")!.className).toContain("ui-btn-ghost");
  });

  test("no friend to add: the link is the coloured button", () => {
    expect(primaries(mount("creator"))).toEqual(["Copy invite link"]);
    document.body.replaceChildren();
    expect(primaries(mount("creator", { i1: "Kari" }, ["i1"]))).toEqual(["Copy invite link"]);
  });

  test("a member sees neither", () => {
    const host = mount("member");
    expect(button(host, "Add a friend")).toBeUndefined();
    expect(host.textContent).not.toContain("Or send a link");
  });

  test("focus moves into the sheet, Escape closes and focus returns", async () => {
    const host = mount("creator", { i1: "Kari" });
    const add = button(host, "Add a friend")!;
    add.focus();
    add.click();
    await vi.waitFor(() => expect(button(host, "Kari")).toBeTruthy());
    await vi.waitFor(() =>
      expect(host.querySelector("[role=dialog]")!.contains(document.activeElement)).toBe(true),
    );
    document.activeElement!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await vi.waitFor(() => expect(host.querySelector("[role=dialog]")).toBeNull());
    await Promise.resolve();
    expect(document.activeElement).toBe(add);
  });

  test("a saved friend is listed and picking asks them", async () => {
    const { gateway } = await import("../gateway");
    vi.mocked(gateway.offerAlbum).mockResolvedValue([null, { ok: true }]);
    const host = mount("creator", { i1: "Kari" });
    button(host, "Add a friend")!.click();
    await vi.waitFor(() => expect(button(host, "Kari")).toBeTruthy());
    button(host, "Kari")!.click();
    await vi.waitFor(() => expect(gateway.offerAlbum).toHaveBeenCalledWith("f1", "i1"));
  });

  test("a kept invite says it waits and offers one Close", async () => {
    const { gateway } = await import("../gateway");
    vi.mocked(gateway.offerAlbum).mockResolvedValue([null, { ok: true, waiting: true }]);
    const host = mount("creator", { i1: "Kari" });
    button(host, "Add a friend")!.click();
    await vi.waitFor(() => expect(button(host, "Kari")).toBeTruthy());
    button(host, "Kari")!.click();
    await vi.waitFor(() =>
      expect(host.querySelector("[role=dialog]")!.textContent!.replace(/\s+/g, " ")).toContain(
        "Kari doesn't have Justus open right now. The invite goes out the next time you both have Justus open, for up to 7 days.",
      ),
    );
    const dialog = host.querySelector<HTMLElement>("[role=dialog]")!;
    expect([...dialog.querySelectorAll("button")].map((b) => b.textContent!.trim())).toEqual([
      "Close",
    ]);
    button(dialog, "Close")!.click();
    await vi.waitFor(() => expect(host.querySelector("[role=dialog]")).toBeNull());
  });

  test("backdrop click is ignored while asking", async () => {
    const { gateway } = await import("../gateway");
    vi.mocked(gateway.offerAlbum).mockReturnValue(new Promise(() => {}));
    const host = mount("creator", { i1: "Kari" });
    button(host, "Add a friend")!.click();
    await vi.waitFor(() => expect(button(host, "Kari")).toBeTruthy());
    button(host, "Kari")!.click();
    await vi.waitFor(() => expect(host.textContent).toContain("Asking Kari"));
    (host.querySelector("[role=dialog]")!.parentElement as HTMLElement).click();
    expect(host.querySelector("[role=dialog]")).not.toBeNull();
    expect(host.textContent).toContain("If Kari doesn't have Justus open, the invite waits.");
  });
});
