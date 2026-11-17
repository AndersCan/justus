// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { render } from "lit-html";
import type { FolderSummary } from "@justus/core";
import { copy } from "../copy/copy";
import { copyWhenReady, invitePanel } from "./invite";

const save = vi.hoisted(() => ({
  fn: vi.fn<() => Promise<[unknown, unknown]>>(),
}));

vi.mock("../gateway", () => ({
  gateway: {
    friends: { list: async () => [null, { friends: [] }] },
    turnOffInvite: vi.fn(),
    saveInviteLink: save.fn,
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

class FakeClipboardItem {
  items: Record<string, Promise<Blob>>;
  constructor(items: Record<string, Promise<Blob>>) {
    this.items = items;
  }
}

const stubClipboard = () => {
  const write = vi.fn(async (items: FakeClipboardItem[]) => {
    await items[0].items["text/plain"];
  });
  vi.stubGlobal("ClipboardItem", FakeClipboardItem);
  Object.defineProperty(navigator, "clipboard", {
    value: { write, writeText: vi.fn(async () => {}) },
    configurable: true,
  });
  return write;
};

const copyButton = (host: HTMLElement) =>
  [...host.querySelectorAll("button")].find((b) =>
    /^(Copy invite link|Copy link)$/.test(b.textContent?.trim() ?? ""),
  );

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("copy starts inside the tap", () => {
  test("copyWhenReady writes before the text arrives and resolves true once written", async () => {
    const write = stubClipboard();
    let arrive: (v: string | null) => void = () => {};
    const done = copyWhenReady(new Promise((r) => (arrive = r)));
    expect(write).toHaveBeenCalledTimes(1);
    arrive("L");
    expect(await done).toBe(true);
  });

  test("no text resolves false and copies nothing", async () => {
    stubClipboard();
    expect(await copyWhenReady(Promise.resolve(null))).toBe(false);
  });

  test("without ClipboardItem the text is written once it arrives", async () => {
    stubClipboard();
    vi.stubGlobal("ClipboardItem", undefined);
    const ok = await copyWhenReady(Promise.resolve("L"));
    expect(ok).toBe(true);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("L");
  });

  test("without ClipboardItem and no text nothing is written", async () => {
    stubClipboard();
    vi.stubGlobal("ClipboardItem", undefined);
    expect(await copyWhenReady(Promise.resolve(null))).toBe(false);
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });

  test("a click with the save pending writes at once, then shows Copied; a second click does nothing", async () => {
    const write = stubClipboard();
    let finish: (v: [unknown, unknown]) => void = () => {};
    save.fn.mockReturnValueOnce(new Promise((r) => (finish = r)));
    const host = document.createElement("div");
    document.body.append(host);
    render(
      invitePanel(folder, "Nils", "Nils", false, () => {}),
      host,
    );
    const button = copyButton(host)!;
    button.click();
    button.click();
    expect(write).toHaveBeenCalledTimes(1);
    finish([null, { ok: true }]);
    await vi.waitFor(() => expect(button.textContent).toBe(copy("invite.copied")));
    expect(host.querySelector('[data-copy-id="invite.copied_paste_it"]')).not.toBeNull();
    expect(write).toHaveBeenCalledTimes(1);
  });
});
