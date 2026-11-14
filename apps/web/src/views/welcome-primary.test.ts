// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { render } from "lit-html";

vi.mock("./toast", () => ({ toast: vi.fn() }));
vi.mock("../gateway", () => ({
  gateway: {
    lock: { status: vi.fn(), setEnabled: vi.fn() },
    setName: vi.fn(),
    folders: vi.fn(),
    createFolder: vi.fn(),
  },
}));

vi.mock("../machines/folders-machine", async (importOriginal) => {
  const real = await importOriginal<typeof import("../machines/folders-machine")>();
  return { ...real, foldersViewModel: vi.fn(real.foldersViewModel) };
});

import { buildInviteLink } from "../utils/invite-link";
import { gateway } from "../gateway";
import { folders, foldersActor, foldersViewModel } from "../machines/folders-machine";
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
  test("Create an album is primary until an invite is pasted, then Ask to join is", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    render(chooseStep(), host);
    const create = host.querySelector("[data-create-album]")!;
    const next = host.querySelector("[data-join-continue]")!;
    expect(create.getAttribute("variant")).toBe("brand");
    expect(create.hasAttribute("appearance")).toBe(false);
    expect(next.className).toContain("ui-btn-ghost");
    vi.stubGlobal("navigator", { clipboard: { readText: async () => link } });
    host.querySelector<HTMLButtonElement>("button[aria-label='Paste from clipboard']")!.click();
    await vi.waitFor(() => expect(next.className).toContain("ui-btn-primary"));
    expect(next.className).not.toContain("ui-btn-ghost");
    expect(create.getAttribute("variant")).toBe("neutral");
    expect(create.getAttribute("appearance")).toBe("filled");
  });

  test("a failed albums load shows a banner with Retry and no red line under Create", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    vi.mocked(gateway.folders).mockResolvedValueOnce([
      new Error("WebSocket replaced by another page holding the session"),
      null,
    ] as never);
    folders.refresh();
    render(chooseStep(), host);
    await vi.waitFor(() => expect(host.querySelectorAll(".ui-error-banner")).toHaveLength(1));
    const banner = host.querySelector(".ui-error-banner")!;
    expect(banner.textContent).toContain("Something went wrong. Try again.");
    expect(host.querySelector(".text-danger-fg")).toBeNull();
    expect(host.querySelector("[data-create-album]")!.hasAttribute("disabled")).toBe(true);
    vi.mocked(gateway.folders).mockResolvedValueOnce([
      null,
      { folders: [], asks: [], offers: [] },
    ] as never);
    banner.querySelector<HTMLButtonElement>(".ui-error-banner-action")!.click();
    await vi.waitFor(() => expect(host.querySelector(".ui-error-banner")).toBeNull());
    expect(host.querySelector("[data-create-album]")!.hasAttribute("disabled")).toBe(false);
  });

  test("a failed Create shows the red line under Create and no banner", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    vi.mocked(gateway.createFolder).mockResolvedValueOnce([new Error("disk full"), null] as never);
    render(chooseStep(), host);
    folders.create("Trip");
    await vi.waitFor(() => expect(host.querySelector(".text-danger-fg")).not.toBeNull());
    expect(host.querySelector(".text-danger-fg")!.textContent).toBe("This phone is out of space.");
    expect(host.querySelector(".ui-error-banner")).toBeNull();
  });

  test("a dead albums actor shows the banner with Reload and no Retry", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const vm = foldersViewModel(foldersActor.snapshot());
    vi.mocked(foldersViewModel).mockReturnValue({
      ...vm,
      fatal: true,
      error: "Internal error (throw): boom",
    });
    const reload = vi.fn();
    vi.stubGlobal("location", { reload });
    render(chooseStep(), host);
    vi.mocked(foldersViewModel).mockRestore();
    const actions = [...host.querySelectorAll<HTMLButtonElement>(".ui-error-banner-action")];
    expect(actions.map((b) => b.textContent!.trim())).toEqual(["Reload app"]);
    actions[0]!.click();
    expect(reload).toHaveBeenCalledOnce();
  });
});
