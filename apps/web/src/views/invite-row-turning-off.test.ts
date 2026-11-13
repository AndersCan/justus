// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { render } from "lit-html";
import type { FolderSummary } from "@justus/core";
import { t } from "../copy/copy";
import { inviteLink } from "../machines/sharing/invite-link";
import { inviteRow } from "./invite";

vi.mock("../gateway", () => ({
  gateway: {
    friends: { list: async () => [null, { friends: [] }] },
    turnOffInvite: vi.fn(() => new Promise(() => {})),
    saveInviteLink: vi.fn(async () => [null, { ok: true }]),
  },
}));

vi.mock("@mantaq/lit", async (orig) => ({
  ...(await orig<object>()),
  watch: (actor: { snapshot(): unknown }, fn: (s: unknown) => unknown) => fn(actor.snapshot()),
}));

const folder = {
  id: "f1",
  name: "Lisbon trip",
  role: "creator",
  invite: { code: "c", owner: "o" },
} as unknown as FolderSummary;

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("invite row while links are being turned off", () => {
  test("Send and Copy link are both off", async () => {
    vi.stubGlobal("navigator", { ...navigator, share: vi.fn() });
    inviteLink.turnOffLink("f1", "c");
    await new Promise((r) => setTimeout(r, 0));
    const host = document.createElement("div");
    document.body.append(host);
    render(inviteRow(folder, "Nils", t("gallery.only_you_until_you_invite")), host);
    const buttons = [...host.querySelectorAll("button")];
    expect(buttons.map((b) => b.textContent?.trim())).toEqual(["Send invite link", "Copy link"]);
    expect(buttons.map((b) => b.disabled)).toEqual([true, true]);
  });
});
