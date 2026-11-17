// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { render } from "lit-html";
import { albumHeader } from "./gallery";
import { open } from "../machines/router-machine";

vi.mock("../gateway", () => ({
  gateway: { list: vi.fn(), add: vi.fn(), upload: vi.fn(), remove: vi.fn() },
}));

const album = { id: "f1", name: "Trip", role: "creator", members: 1 };
const alone = { folder: { id: "f1" }, members: [{ key: "k0", name: "Me", connected: true }] };
const allAlbums = () => {
  const host = document.createElement("div");
  document.body.append(host);
  const page = { status: alone, folders: [album], requests: [], photos: [], lastSync: Date.now() };
  render(albumHeader(page as never, album as never), host);
  const link = [...host.querySelectorAll("a")].find((a) => a.getAttribute("href") === "/albums");
  if (!link) throw new Error("no All albums link");
  return link;
};

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("All albums link", () => {
  test("opened from the grid, a click goes back instead of adding an entry", () => {
    history.replaceState(null, "", "/albums");
    open("/albums/f1");
    const back = vi.spyOn(history, "back").mockImplementation(() => {});
    const push = vi.spyOn(history, "pushState");
    const click = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    allAlbums().dispatchEvent(click);
    expect(back).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
    expect(click.defaultPrevented).toBe(true);
  });

  test("a ctrl click keeps the browser default and does not go back", () => {
    history.replaceState(null, "", "/albums");
    open("/albums/f1");
    const back = vi.spyOn(history, "back").mockImplementation(() => {});
    const click = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
      ctrlKey: true,
    });
    allAlbums().dispatchEvent(click);
    expect(back).not.toHaveBeenCalled();
    expect(click.defaultPrevented).toBe(false);
  });
});
