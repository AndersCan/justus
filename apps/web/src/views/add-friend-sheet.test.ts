// @vitest-environment happy-dom
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { render } from "lit-html";
import type { FolderSummary } from "@justus/core";
import { addFriend } from "../machines/sharing/add-friend";
import { addFriendSheetView } from "./add-friend-sheet";
import { invitePanel } from "./invite";
import { toast } from "./toast";

vi.mock("./toast", () => ({ toast: vi.fn() }));
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
  [...host.querySelectorAll("button")].find(
    (b) =>
      b.textContent?.replace(/\s*›\s*$/, "").trim() === text ||
      b.querySelector("span > span")?.textContent === text,
  );

const box = (host: HTMLElement, name: string) =>
  [...host.querySelectorAll<HTMLInputElement>("input[type=checkbox]")].find(
    (i) => i.closest("label")?.textContent?.trim() === name,
  )!;

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

  test("the invite card has no coloured button", () => {
    const host = mount("creator", { i1: "Kari" });
    expect(primaries(host)).toEqual([]);
    expect(button(host, "Add a friend")!.className).toContain("ui-btn-ghost");
    document.body.replaceChildren();
    expect(primaries(mount("creator"))).toEqual([]);
  });

  test("friend rows in the picker are checkboxes named by the friend", async () => {
    const host = mount("creator", { i1: "Kari", i2: "ole" });
    button(host, "Add a friend")!.click();
    await vi.waitFor(() => expect(box(host, "Kari")).toBeTruthy());
    expect(box(host, "ole")).toBeTruthy();
    expect(box(host, "Kari").checked).toBe(false);
  });

  test("role buttons are disabled until someone is ticked and then name who", async () => {
    const host = mount("creator", { i1: "Kari", i2: "ole" });
    button(host, "Add a friend")!.click();
    await vi.waitFor(() => expect(box(host, "Kari")).toBeTruthy());
    const viewers = () => button(host, "Add  as Viewers") as HTMLButtonElement;
    expect(viewers().disabled).toBe(true);
    box(host, "Kari").click();
    await vi.waitFor(() => expect(button(host, "Add Kari as Viewers")).toBeTruthy());
    box(host, "ole").click();
    await vi.waitFor(() => expect(button(host, "Add Kari and ole as Viewers")).toBeTruthy());
    expect((button(host, "Add Kari and ole as Viewers") as HTMLButtonElement).disabled).toBe(false);
    expect(button(host, "Add Kari and ole as Collaborators")).toBeTruthy();
    box(host, "Kari").click();
    box(host, "ole").click();
    await vi.waitFor(() => expect(viewers().disabled).toBe(true));
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
    await vi.waitFor(() => expect(box(host, "Kari")).toBeTruthy());
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

  test("ticking two friends asks both and toasts once", async () => {
    const { gateway } = await import("../gateway");
    vi.mocked(gateway.offerAlbum).mockReset();
    vi.mocked(gateway.offerAlbum).mockResolvedValue([null, { ok: true }]);
    vi.mocked(toast).mockClear();
    const host = mount("creator", { i1: "Kari", i2: "ole" });
    button(host, "Add a friend")!.click();
    await vi.waitFor(() => expect(box(host, "Kari")).toBeTruthy());
    box(host, "Kari").click();
    box(host, "ole").click();
    await vi.waitFor(() => expect(button(host, "Add Kari and ole as Viewers")).toBeTruthy());
    button(host, "Add Kari and ole as Viewers")!.click();
    await vi.waitFor(() => expect(gateway.offerAlbum).toHaveBeenCalledTimes(2));
    expect(gateway.offerAlbum).toHaveBeenCalledWith("f1", "i1", "reader");
    expect(gateway.offerAlbum).toHaveBeenCalledWith("f1", "i2", "reader");
    await vi.waitFor(() =>
      expect(toast).toHaveBeenCalledWith("Asked Kari and ole to join as Viewers"),
    );
    expect(toast).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(host.querySelector("[role=dialog]")).toBeNull());
  });

  test("a Collaborator is asked with member", async () => {
    const { gateway } = await import("../gateway");
    vi.mocked(gateway.offerAlbum).mockReset();
    vi.mocked(gateway.offerAlbum).mockResolvedValue([null, { ok: true }]);
    const host = mount("creator", { i1: "Kari" });
    button(host, "Add a friend")!.click();
    await vi.waitFor(() => expect(box(host, "Kari")).toBeTruthy());
    box(host, "Kari").click();
    await vi.waitFor(() => expect(button(host, "Add Kari as Collaborators")).toBeTruthy());
    expect(host.querySelector("[role=dialog]")!.getAttribute("aria-label")).toBe(
      "Add a friend to “Lisbon trip”",
    );
    expect(gateway.offerAlbum).not.toHaveBeenCalled();
    button(host, "Add Kari as Collaborators")!.click();
    await vi.waitFor(() => expect(gateway.offerAlbum).toHaveBeenCalledWith("f1", "i1", "member"));
    await vi.waitFor(() =>
      expect(toast).toHaveBeenCalledWith("Asked Kari to join as Collaborators"),
    );
  });

  test("a partial result shows one line per friend and one Close, no toast", async () => {
    const { gateway } = await import("../gateway");
    vi.mocked(gateway.offerAlbum).mockReset();
    vi.mocked(gateway.offerAlbum).mockImplementation(async (_f, identity) =>
      identity === "i1" ? [null, { ok: true }] : [null, { ok: true, waiting: true }],
    );
    vi.mocked(toast).mockClear();
    const host = mount("creator", { i1: "Kari", i2: "ole" });
    button(host, "Add a friend")!.click();
    await vi.waitFor(() => expect(box(host, "Kari")).toBeTruthy());
    box(host, "Kari").click();
    box(host, "ole").click();
    await vi.waitFor(() => expect(button(host, "Add Kari and ole as Viewers")).toBeTruthy());
    button(host, "Add Kari and ole as Viewers")!.click();
    const dialog = () => host.querySelector<HTMLElement>("[role=dialog]")!;
    await vi.waitFor(() =>
      expect([...dialog().querySelectorAll("li")].map((l) => l.textContent!.trim())).toEqual([
        "Asked Kari.",
        "ole doesn't have Justus open right now. The invite goes out the next time you both have Justus open, for up to 7 days.",
      ]),
    );
    expect([...dialog().querySelectorAll("button")].map((b) => b.textContent!.trim())).toEqual([
      "Close",
    ]);
    expect(toast).not.toHaveBeenCalled();
    button(dialog(), "Close")!.click();
    await vi.waitFor(() => expect(host.querySelector("[role=dialog]")).toBeNull());
  });

  test("backdrop click is ignored while asking", async () => {
    const { gateway } = await import("../gateway");
    vi.mocked(gateway.offerAlbum).mockReset();
    vi.mocked(gateway.offerAlbum).mockReturnValue(new Promise(() => {}));
    const host = mount("creator", { i1: "Kari", i2: "ole" });
    const opener = button(host, "Add a friend")!;
    opener.focus();
    opener.click();
    await vi.waitFor(() => expect(box(host, "Kari")).toBeTruthy());
    box(host, "Kari").click();
    box(host, "ole").click();
    await vi.waitFor(() => expect(button(host, "Add Kari and ole as Viewers")).toBeTruthy());
    button(host, "Add Kari and ole as Viewers")!.click();
    await vi.waitFor(() => expect(host.textContent).toContain("Asking Kari and ole"));
    await vi.waitFor(() =>
      expect(host.querySelector("[role=dialog]")!.contains(document.activeElement)).toBe(true),
    );
    (host.querySelector("[role=dialog]")!.parentElement as HTMLElement).click();
    await Promise.resolve();
    expect(host.querySelector("[role=dialog]")).not.toBeNull();
    expect(document.activeElement).not.toBe(opener);
    expect(host.textContent).toContain("If someone doesn't have Justus open, their invite waits.");
  });
});
