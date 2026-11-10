// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { render } from "lit-html";

vi.mock("./toast", () => ({ toast: vi.fn() }));
vi.mock("../gateway", () => ({
  gateway: {
    lock: { status: vi.fn(), setEnabled: vi.fn() },
    setName: vi.fn(),
    folders: vi.fn(),
  },
}));

import { buildInviteLink } from "../utils/invite-link";
import { chooseStep } from "./welcome";

const link = buildInviteLink({
  code: "a".repeat(64),
  owner: "b".repeat(64),
  album: "Trip",
  ownerName: "Nils",
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("Start sharing screen", () => {
  test("Create an album is primary until an invite is pasted, then Continue is", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    render(chooseStep(), host);
    const create = host.querySelector("[data-create-album]")!;
    const next = host.querySelector("[data-join-continue]")!;
    expect(create.getAttribute("variant")).toBe("brand");
    expect(next.className).toContain("ui-btn-ghost");
    vi.stubGlobal("navigator", { clipboard: { readText: async () => link } });
    host.querySelector<HTMLButtonElement>("button[aria-label='Paste from clipboard']")!.click();
    await vi.waitFor(() => expect(next.className).toContain("ui-btn-primary"));
    expect(next.className).not.toContain("ui-btn-ghost");
    expect(create.getAttribute("variant")).toBe("neutral");
  });
});
