// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { render } from "lit-html";
import type { FolderSummary } from "@justus/core";
import { invitePanel, shareInvite } from "./invite";

const send = vi.hoisted(() => vi.fn(async (_text: string) => [null, { shown: true }]));

vi.mock("../gateway", () => ({
  gateway: {
    friends: { list: async () => [null, { friends: [] }] },
    turnOffInvite: vi.fn(),
    saveInviteLink: vi.fn(async () => [null, { ok: true }]),
    share: { send },
  },
}));

const folder = {
  id: "f1",
  name: "Lisbon trip",
  role: "creator",
  invite: { code: "c", owner: "o" },
} as unknown as FolderSummary;

const setStore = (on: boolean) =>
  Object.defineProperty(window, "BareShell", { value: on ? true : undefined, configurable: true });
const setWebShare = (on: boolean) =>
  Object.defineProperty(navigator, "share", {
    value: on ? vi.fn(async () => {}) : undefined,
    configurable: true,
  });

const buttons = () => {
  const host = document.createElement("div");
  render(
    invitePanel(folder, "Nils", "Nils", false, () => {}),
    host,
  );
  return [...host.querySelectorAll("button")].map((b) => b.textContent?.trim());
};

afterEach(() => {
  setStore(false);
  setWebShare(false);
  vi.clearAllMocks();
});

describe("Send invite link in the store apps", () => {
  test("opens the phone's sheet with the message and copies nothing", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    setStore(true);
    await shareInvite(folder, "Nils");
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toMatch(
      /^Ask to join my Justus album “Lisbon trip”: justus:\/\/join\?/,
    );
    expect(writeText).not.toHaveBeenCalled();
  });

  test("Send shows when the phone hosts the page", () => {
    setStore(true);
    expect(buttons()).toContain("Send invite link");
  });

  test("Send is hidden without a host or Web Share", () => {
    expect(buttons()).not.toContain("Send invite link");
  });
});
