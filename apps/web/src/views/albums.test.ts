// @vitest-environment happy-dom
import { describe, expect, test, vi } from "vite-plus/test";
import { html, render } from "lit-html";
import { folders, foldersActor } from "../machines/folders-machine";
import { friendOffer, friendOfferActor } from "../machines/sharing/friend-offer";
import { joinActor } from "../machines/sharing/join-request";
import { albumsPanel, joinPanel, pendingAsks } from "./albums";

const mock = vi.hoisted(() => ({
  folders: vi.fn(),
  requests: vi.fn(),
  status: vi.fn(),
  joinOffer: vi.fn(),
}));
vi.mock("../gateway", () => ({
  gateway: {
    folders: mock.folders,
    requests: mock.requests,
    status: mock.status,
    ask: vi.fn(),
    joinOffer: mock.joinOffer,
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

const offer = {
  code: "o1",
  owner: "nils-id",
  albumName: "Lisbon trip",
  ownerName: "Nils",
};

async function load(
  ids: string[],
  asks: ReturnType<typeof ask>[] = [],
  offers: (typeof offer)[] = [],
) {
  mock.folders.mockResolvedValue([
    null,
    { folders: ids.map(album), asks, offers, activeFolderId: ids[0] ?? null },
  ]);
  folders.refresh();
  await vi.waitFor(() =>
    expect(foldersActor.snapshot().context.folders.map((f) => f.id)).toEqual(ids),
  );
  await foldersActor.settled();
  await vi.waitFor(() => expect(foldersActor.snapshot().context.asks).toEqual(asks));
  await vi.waitFor(() => expect(foldersActor.snapshot().context.offers).toEqual(offers));
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

describe("Photos page wiring", () => {
  test("shows the waiting row at all scope and hides it inside an album", async () => {
    const { galleryView } = await import("./gallery");
    const all = document.createElement("div");
    render(galleryView({ kind: "all" } as any), all);
    const inAlbum = document.createElement("div");
    render(galleryView({ kind: "album", id: "zzz" } as any), inAlbum);
    await load(["a"], [ask("waiting")]);
    await vi.waitFor(() =>
      expect(all.querySelector("section[aria-label='Waiting to join']")).not.toBeNull(),
    );
    expect(inAlbum.querySelector("section[aria-label='Waiting to join']")).toBeNull();
  });
});

describe("join card", () => {
  test("has the invite input, a Paste button and a Continue button", async () => {
    const host = document.createElement("div");
    render(joinPanel(), host);
    await vi.waitFor(() =>
      expect(host.querySelector("input[aria-label='Invite link']")).not.toBeNull(),
    );
    expect(host.querySelector("button[aria-label='Paste from clipboard']")?.textContent).toContain(
      "Paste",
    );
    expect(host.querySelector("button[type='submit']")?.textContent).toContain("Continue");
    expect(host.querySelectorAll("section")).toHaveLength(1);
  });

  test("Continue is enabled once sync has settled", async () => {
    const { sync, syncActor } = await import("../machines/sync-machine");
    const host = document.createElement("div");
    render(joinPanel(), host);
    mock.status.mockResolvedValue([null, { name: "Me", members: [] }]);
    sync.refresh();
    await vi.waitFor(() => expect(syncActor.snapshot().path[0]).toBe("showingAlbum"));
    await syncActor.settled();
    await vi.waitFor(() =>
      expect(host.querySelector<HTMLButtonElement>("button[type='submit']")?.disabled).toBe(false),
    );
  });

  test("the start screen pairs the waiting row with the join card", async () => {
    const host = document.createElement("div");
    render(html`${pendingAsks()}${joinPanel()}`, host);
    await load(["a"], [ask("waiting")]);
    expect(host.querySelector("section[aria-label='Waiting to join']")).not.toBeNull();
    expect(host.querySelector("input[aria-label='Invite link']")).not.toBeNull();
  });
});

describe("friend invites", () => {
  test("an invite row shows who invited you and a Join button above the albums", async () => {
    const host = document.createElement("div");
    render(albumsPanel(), host);
    await load(["a"], [], [offer]);
    const [first, second] = rows(host);
    expect(first?.textContent).toContain("Lisbon trip");
    expect(first?.textContent).toContain("Nils invited you");
    expect(first?.querySelector("button")?.textContent?.trim()).toBe("Join");
    expect(second?.textContent).toContain("Album a");
  });

  test("with invites only, the list shows instead of No albums yet", async () => {
    const host = document.createElement("div");
    render(albumsPanel(), host);
    await load([], [], [offer]);
    expect(host.textContent).not.toContain("No albums yet");
    expect(rows(host)).toHaveLength(1);
  });

  test("Join asks the backend and the row shows Joining", async () => {
    mock.joinOffer.mockReturnValue(new Promise(() => {}));
    const host = document.createElement("div");
    render(albumsPanel(), host);
    await load([], [], [offer]);
    host.querySelector("button")?.click();
    await vi.waitFor(() => expect(friendOfferActor.snapshot().path[0]).toBe("joiningFriendsAlbum"));
    expect(mock.joinOffer).toHaveBeenCalledWith("o1", "nils-id");
    await vi.waitFor(() => expect(host.textContent).toContain("Joining “Lisbon trip”..."));
    expect(host.querySelector("button")?.hasAttribute("disabled")).toBe(true);
  });

  test("an accepted answer opens the album", async () => {
    mock.joinOffer.mockReturnValue(new Promise(() => {}));
    const host = document.createElement("div");
    render(albumsPanel(), host);
    await load([], [], [offer]);
    host.querySelector("button")?.click();
    await vi.waitFor(() => expect(friendOfferActor.snapshot().path[0]).toBe("joiningFriendsAlbum"));
    friendOffer.askAnswered("o1", "accepted", "f9");
    await vi.waitFor(() => expect(location.pathname + location.hash).toContain("/albums/f9"));
  });

  test("a failed join says why in a toast", async () => {
    mock.joinOffer.mockRejectedValue(new Error("boom"));
    const host = document.createElement("div");
    render(albumsPanel(), host);
    await load([], [], [offer]);
    host.querySelector("button")?.click();
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain(
        "Couldn't join “Lisbon trip”. Nils needs Justus open too.",
      ),
    );
  });
});
