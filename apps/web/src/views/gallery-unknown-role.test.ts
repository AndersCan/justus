// @vitest-environment happy-dom
import { describe, expect, test, vi } from "vite-plus/test";
import { render } from "lit-html";
import { foldersActor } from "../machines/folders-machine";
import { addableAlbum, dropOverlay } from "./gallery";

const hoisted = vi.hoisted(() => ({
  gateway: { list: vi.fn(), add: vi.fn(), upload: vi.fn(), remove: vi.fn() },
  toast: vi.fn(),
}));
vi.mock("../gateway", () => ({ gateway: hoisted.gateway }));
vi.mock("./toast", () => ({ toast: hoisted.toast }));

const album = {
  id: "f1",
  name: "Trip",
  role: "reader",
  members: 2,
  invite: { code: "c", owner: "o" },
};

describe("adding to an album whose role is not known yet", () => {
  test("a drop says Getting your access…, not that you cannot add", () => {
    const host = document.createElement("div");
    render(
      dropOverlay({ folders: [album], status: null } as never, { kind: "album", id: "f1" }),
      host,
    );
    const text = host.textContent?.replace(/\s+/g, " ").trim();
    expect(text).toBe("Getting your access…");
    expect(text).not.toMatch(/can't add|Ask the admin/i);
  });

  test("a picker or drop attempt toasts Getting your access…, not the Viewer message", () => {
    vi.spyOn(foldersActor, "snapshot").mockReturnValue({ context: { folders: [album] } } as never);
    expect(addableAlbum("f1")).toBeNull();
    expect(hoisted.toast).toHaveBeenCalledTimes(1);
    expect(hoisted.toast).toHaveBeenCalledWith("Getting your access…");
  });
});
