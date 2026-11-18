// @vitest-environment happy-dom
import { expect, test, vi } from "vite-plus/test";
import { render } from "lit-html";
import { folders, foldersActor } from "../machines/folders-machine";
import { galleryView } from "./gallery";

const mock = vi.hoisted(() => ({ folders: vi.fn() }));
vi.mock("../gateway", () => ({
  gateway: {
    folders: mock.folders,
    requests: vi.fn().mockResolvedValue([null, []]),
    status: vi.fn().mockResolvedValue([null, null]),
    logs: { view: vi.fn(), clear: vi.fn() },
  },
}));

const list = (whoLeft?: string[]) => [
  null,
  {
    folders: [
      {
        id: "w",
        name: "Trip",
        role: "creator",
        members: 1,
        pending: false,
        ...(whoLeft ? { whoLeft } : {}),
      },
    ],
    asks: [],
    offers: [],
    activeFolderId: "w",
  },
];

test("the album page's who-left Dismiss is on once the list loads, off while it reloads, gone when nobody left", async () => {
  const host = document.createElement("div");
  render(galleryView({ kind: "album", id: "w" }), host);
  const sel = "[aria-label='Dismiss notice about Trip']";
  mock.folders.mockResolvedValue(list(["Ben"]));
  folders.refresh();
  await foldersActor.settled();
  await vi.waitFor(() => expect(host.querySelector(sel)).not.toBeNull());
  expect(host.textContent).toContain("Ben left this album.");
  expect(host.querySelector<HTMLButtonElement>(sel)!.disabled).toBe(false);

  let finish = (_: unknown) => {};
  mock.folders.mockReturnValue(new Promise((resolve) => (finish = resolve)));
  folders.refresh();
  await vi.waitFor(() => expect(host.querySelector<HTMLButtonElement>(sel)!.disabled).toBe(true));

  finish(list());
  await foldersActor.settled();
  await vi.waitFor(() => expect(host.querySelector(sel)).toBeNull());
  expect(host.querySelector("[aria-label^='Dismiss notice']")).toBeNull();
});
