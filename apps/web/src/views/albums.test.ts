// @vitest-environment happy-dom
import { describe, expect, test, vi } from "vite-plus/test";
import { render } from "lit-html";
import { folders, foldersActor } from "../machines/folders-machine";
import { joinActor } from "../machines/sharing/join-request";
import { albumsPanel, pendingAsks } from "./albums";

const mock = vi.hoisted(() => ({
  folders: vi.fn(),
  requests: vi.fn(),
  status: vi.fn(),
}));
vi.mock("../gateway", () => ({
  gateway: {
    folders: mock.folders,
    requests: mock.requests,
    status: mock.status,
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

const ask = (status: "waiting" | "declined") => ({
  code: "c1",
  owner: "anna-id",
  ownerName: "Anna",
  albumName: "Summer trip",
  status,
});

async function load(ids: string[], asks: ReturnType<typeof ask>[] = []) {
  mock.folders.mockResolvedValue([
    null,
    { folders: ids.map(album), asks, activeFolderId: ids[0] ?? null },
  ]);
  folders.refresh();
  await vi.waitFor(() =>
    expect(foldersActor.snapshot().context.folders.map((f) => f.id)).toEqual(ids),
  );
  await foldersActor.settled();
  await vi.waitFor(() => expect(foldersActor.snapshot().context.asks).toEqual(asks));
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

describe("albums wiring", () => {
  test("sync-state changes after the first refresh requests", async () => {
    const { sync, syncActor } = await import("../machines/sync-machine");
    const { requests } = await import("../machines/requests-machine");
    const refresh = vi.spyOn(requests, "refresh").mockImplementation(() => {});
    mock.status.mockResolvedValue([null, { name: "Me", members: [] }]);
    // idle -> refreshing is the first change and is only remembered; refreshing -> ok refreshes
    sync.refresh();
    await vi.waitFor(() => expect(syncActor.snapshot().path[0]).toBe("showingAlbum"));
    expect(refresh).toHaveBeenCalledTimes(1);
    sync.refresh();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(3));
  });

  test("moving from one album to another closes the people sheet", async () => {
    const { people, peopleActor } = await import("../machines/people-machine");
    const { open } = await import("../machines/router-machine");
    open("/sharing/a");
    await vi.waitFor(() => expect(peopleActor.snapshot().path[0]).toBe("showingPeople"));
    people.showQr();
    expect(peopleActor.snapshot().context.qrShown).toBe(true);
    open("/sharing/b");
    await vi.waitFor(() => expect(peopleActor.snapshot().context.qrShown).toBe(false));
    expect(peopleActor.snapshot().path[0]).toBe("showingPeople");
  });
});

describe("pending asks", () => {
  test("renders nothing with no asks, or only a declined one", async () => {
    const host = document.createElement("div");
    render(pendingAsks(), host);
    await load(["a"]);
    expect(host.querySelector("section")).toBeNull();
    await load(["a"], [ask("declined")]);
    expect(host.querySelector("section")).toBeNull();
  });

  test("a waiting ask shows one row that reopens the waiting sheet", async () => {
    const host = document.createElement("div");
    render(pendingAsks(), host);
    await load(["a"], [ask("waiting")]);
    const section = host.querySelector("section[aria-label='Waiting to join']");
    expect(section?.textContent).toContain("Waiting for Anna to accept");
    expect(section?.querySelectorAll("li")).toHaveLength(1);
    section?.querySelector("button")?.click();
    await vi.waitFor(() => expect(joinActor.snapshot().path[0]).toBe("waitingForAdminToAccept"));
  });

  test("the albums panel still lists waiting and declined rows", async () => {
    const host = document.createElement("div");
    render(albumsPanel(), host);
    await load(["a"], [ask("waiting"), { ...ask("declined"), code: "c2" }]);
    expect(host.textContent).toContain("Waiting for Anna to accept");
    expect(host.textContent).toContain("Not accepted");
  });
});
