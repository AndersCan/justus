// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { render } from "lit-html";
import type { FolderSummary } from "@justus/core";
import { t } from "../copy/copy";
import { gateway } from "../gateway";
import { inviteLink } from "../machines/sharing/invite-link";
import { inviteRow } from "./invite";

vi.mock("../gateway", () => ({
  gateway: {
    friends: { list: async () => [null, { friends: [] }] },
    turnOffInvite: vi.fn(),
    saveInviteLink: vi.fn(async () => [null, { ok: true }]),
  },
}));

vi.mock("@mantaq/lit", async (orig) => ({
  ...(await orig<object>()),
  watch: (actor: { snapshot(): unknown }, fn: (s: unknown) => unknown) => fn(actor.snapshot()),
}));

const folder = (code: string) =>
  ({
    id: "f1",
    name: "Lisbon trip",
    role: "creator",
    invite: { code, owner: "o" },
  }) as unknown as FolderSummary;

const rowButtons = (code: string) => {
  const host = document.createElement("div");
  document.body.append(host);
  render(inviteRow(folder(code), "Nils", t("gallery.only_you_until_you_invite")), host);
  return [...host.querySelectorAll("button")];
};

const settle = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("invite row while links are turned off", () => {
  test("the buttons stay off for the turned-off code once the turn-off finishes", async () => {
    vi.stubGlobal("navigator", { ...navigator, share: vi.fn() });
    vi.mocked(gateway.turnOffInvite).mockResolvedValueOnce([null, {}] as never);
    inviteLink.turnOffLink("f1", "c");
    await settle();
    const buttons = rowButtons("c");
    expect(buttons.map((b) => b.textContent?.trim())).toEqual(["Send invite link", "Copy link"]);
    expect(buttons.map((b) => b.disabled)).toEqual([true, true]);
  });

  test("a new code gets working buttons again", () => {
    vi.stubGlobal("navigator", { ...navigator, share: vi.fn() });
    expect(rowButtons("fresh").map((b) => b.disabled)).toEqual([false, false]);
  });

  test("the web Copy button is off for the turned-off code too", () => {
    expect(rowButtons("c").map((b) => b.disabled)).toEqual([true]);
  });
});
