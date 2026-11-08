// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { render } from "lit-html";
import type { FolderSummary } from "@justus/core";
import { inviteLink } from "../machines/sharing/invite-link";
import { checkCodeLine, friendNamesLine, invitePanel } from "./invite";

vi.mock("../gateway", () => ({
  gateway: {
    friends: { list: async () => [null, { friends: [] }] },
    turnOffInvite: vi.fn(() => new Promise(() => {})),
  },
}));

const LINE = "Send it in any chat. They need Justus installed.";

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
  render(
    invitePanel(folder(role), "Nils", "Nils", false, () => {}),
    host,
  );
  return host;
};

const copyButton = (host: HTMLElement) =>
  [...host.querySelectorAll("button")].find((b) =>
    /^(Copy invite link|Copy link|Copied ✓)$/.test(b.textContent?.trim() ?? ""),
  );

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("invite card send hint", () => {
  test("the Admin sees where to send the link", () => {
    const host = mount("creator");
    expect(host.textContent).toContain(LINE);
  });

  test("the line stays after Copy turns back", async () => {
    vi.useFakeTimers();
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn(async () => {}) },
      configurable: true,
    });
    const host = mount("creator");
    const label = copyButton(host)!.textContent!.trim();
    copyButton(host)!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(copyButton(host)!.textContent).toBe("Copied ✓");
    expect(host.textContent).toContain(LINE);
    await vi.advanceTimersByTimeAsync(3000);
    expect(copyButton(host)!.textContent!.trim()).toBe(label);
    expect(host.textContent).toContain(LINE);
  });

  test("a member sees no line", () => {
    const host = mount("member");
    expect(host.textContent).not.toContain(LINE);
  });

  test("no line while links are being turned off", async () => {
    inviteLink.turnOffLink("f1", "c");
    await new Promise((r) => setTimeout(r, 0));
    const host = mount("creator");
    expect(host.textContent).not.toContain(LINE);
    expect(copyButton(host)!.disabled).toBe(true);
  });
});

describe("friendNamesLine", () => {
  const names = (...n: string[]) => friendNamesLine(n.map((name) => ({ identity: name, name })));
  test.each([
    [["Ben"], "From your friends: Ben. They get the invite in Justus, no link needed."],
    [
      ["Ben", "Kari"],
      "From your friends: Ben or Kari. They get the invite in Justus, no link needed.",
    ],
    [
      ["Ånna", "Kari", "ole"],
      "From your friends: Ånna, Kari or ole. They get the invite in Justus, no link needed.",
    ],
    [
      ["A", "B", "C", "D", "E"],
      "From your friends: A, B, C or 2 more. They get the invite in Justus, no link needed.",
    ],
  ])("%j", (list, text) => {
    expect(names(...list)).toBe(text);
  });
});

describe("checkCodeLine", () => {
  test("is null without a code", () => {
    expect(checkCodeLine(undefined, "Anna")).toBeNull();
  });
  test("names the code and who sees it", () => {
    const host = document.createElement("div");
    render(checkCodeLine("1234 5678", "Anna"), host);
    expect(host.textContent?.replace(/\s+/g, " ").trim()).toBe(
      "Your check code is 1234 5678. Anna sees the same code next to your request.",
    );
  });
});
