// @vitest-environment happy-dom
import { describe, expect, test, vi } from "vite-plus/test";
import { render } from "lit-html";
import { folders, foldersActor } from "../machines/folders-machine";
import { albumsPanel } from "./albums";

const mock = vi.hoisted(() => ({
  folders: vi.fn(),
  requests: vi.fn(),
}));
vi.mock("../gateway", () => ({
  gateway: {
    folders: mock.folders,
    requests: mock.requests,
    status: vi.fn(),
    ask: vi.fn(),
    logs: { view: vi.fn(), clear: vi.fn() },
  },
}));

const album = (id: string) => ({
  id,
  name: `Album ${id}`,
  role: "creator",
  members: 1,
  pending: false,
});

async function load(ids: string[]) {
  mock.folders.mockResolvedValue([
    null,
    { folders: ids.map(album), asks: [], activeFolderId: ids[0] ?? null },
  ]);
  folders.refresh();
  await vi.waitFor(() =>
    expect(foldersActor.snapshot().context.folders.map((f) => f.id)).toEqual(ids),
  );
  await foldersActor.settled();
}

const rows = (host: HTMLElement) => [
  ...host.querySelectorAll<HTMLLIElement>("ul[aria-label='Your albums'] > li"),
];

describe("albums list", () => {
  test("removing the middle album keeps the other rows, and adding one keeps every row", async () => {
    const host = document.createElement("div");
    render(albumsPanel(), host);
    await load(["a", "b", "c"]);
    const [first, middle, last] = rows(host);
    expect(rows(host)).toHaveLength(3);

    await load(["a", "c"]);
    expect(rows(host)).toHaveLength(2);
    expect(rows(host)[0]).toBe(first);
    expect(rows(host)[1]).toBe(last);
    expect(middle.isConnected).toBe(false);

    await load(["a", "c", "d"]);
    expect(rows(host)).toHaveLength(3);
    expect(rows(host)[0]).toBe(first);
    expect(rows(host)[1]).toBe(last);
  });
});
