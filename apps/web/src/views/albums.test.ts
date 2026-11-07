// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { html, render } from "lit-html";
import { folders, foldersActor } from "../machines/folders-machine";
import { friendOffer, friendOfferActor } from "../machines/sharing/friend-offer";
import { join, joinActor } from "../machines/sharing/join-request";
import { buildInviteLink } from "../utils/invite-link";
import { sharingView } from "./sharing";
import { albumVanished, albumsPanel, archivedSummary, joinPanel, pendingAsks } from "./albums";

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

describe("Join tab", () => {
  test("shows a waiting ask above the link box", async () => {
    const host = document.createElement("div");
    render(sharingView("join"), host);
    await load(["a"], [ask("waiting")]);
    const sections = host.querySelectorAll("section[aria-label='Waiting to join']");
    expect(sections).toHaveLength(1);
    expect(sections[0].textContent).toContain("Summer trip");
    expect(sections[0].textContent).toContain("Waiting for Anna to accept");
    const input = host.querySelector("input[aria-label='Invite link']") as Node;
    expect(
      sections[0].compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test("shows no waiting heading with nothing waiting or only a declined ask", async () => {
    const host = document.createElement("div");
    render(sharingView("join"), host);
    await load(["a"]);
    expect(host.querySelector("section[aria-label='Waiting to join']")).toBeNull();
    await load(["a"], [ask("declined")]);
    expect(host.querySelector("section[aria-label='Waiting to join']")).toBeNull();
  });

  const submit = (host: HTMLElement, text: string) => {
    const input = host.querySelector("input[aria-label='Invite link']") as HTMLInputElement;
    input.value = text;
    input.form?.dispatchEvent(new Event("submit", { cancelable: true }));
    return input;
  };

  test("Continue with an invite link empties the box", async () => {
    const host = document.createElement("div");
    render(joinPanel(), host);
    const link = buildInviteLink({
      code: "a".repeat(64),
      owner: "b".repeat(64),
      album: "Trip",
      ownerName: "Nils",
    });
    const input = submit(host, link);
    expect(input.value).toBe("");
    expect(joinActor.snapshot().path[0]).toBe("decidingToAsk");
    join.notNow();
  });

  test("Continue with a garbled link keeps the text", async () => {
    const host = document.createElement("div");
    render(joinPanel(), host);
    const input = submit(host, "not a link");
    expect(input.value).toBe("not a link");
    expect(joinActor.snapshot().path[0]).toBe("showingLinkProblem");
    join.notNow();
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

describe("albums list motion", () => {
  type Call = { el: Element; keyframes: any; options: any };
  let calls: Call[];
  const saved = {
    animate: Element.prototype.animate,
    getAnimations: Element.prototype.getAnimations,
    rect: Element.prototype.getBoundingClientRect,
    matchMedia: window.matchMedia,
  };

  beforeEach(() => {
    calls = [];
    Element.prototype.animate = function (this: Element, keyframes: any, options: any) {
      calls.push({ el: this, keyframes, options });
      return { finished: Promise.resolve() } as any;
    };
    Element.prototype.getAnimations = (() => []) as any;
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const i = this.parentElement ? [...this.parentElement.children].indexOf(this) : 0;
      return { left: 0, top: i * 56, width: 300, height: 56 } as any;
    };
    window.matchMedia = (() => ({ matches: false })) as any;
    window.innerWidth = 400;
    window.innerHeight = 800;
  });

  afterEach(() => {
    Element.prototype.animate = saved.animate;
    Element.prototype.getAnimations = saved.getAnimations;
    Element.prototype.getBoundingClientRect = saved.rect;
    window.matchMedia = saved.matchMedia;
    document.body.replaceChildren();
  });

  const mount = async (...args: Parameters<typeof load>) => {
    await load(...args);
    const host = document.createElement("div");
    document.body.append(host);
    render(albumsPanel(), host);
    const before = rows(host);
    calls = [];
    return { host, before };
  };
  // Hosts from earlier tests stay subscribed to the shared actors.
  const own = (host: HTMLElement) => calls.filter((c) => host.contains(c.el));

  test("a new album fades in and the rows already there keep their elements", async () => {
    const { host, before } = await mount(["a", "b"]);
    await load(["a", "b", "c"]);
    await Promise.resolve();
    rows(host)
      .slice(0, 2)
      .forEach((row, i) => expect(row).toBe(before[i]));
    const mine = own(host);
    expect(mine).toHaveLength(1);
    expect((mine[0].el as HTMLElement).dataset.motionKey).toBe("album:c");
    expect(mine[0].keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);
  });

  test("a row that leaves fades out in place and the rows below slide up", async () => {
    const { host, before } = await mount(["a", "b", "c"]);
    // Hold the animations open: load() awaits long enough for them to finish.
    let finish = () => {};
    const open = new Promise<void>((resolve) => (finish = resolve));
    Element.prototype.animate = function (this: Element, keyframes: any, options: any) {
      calls.push({ el: this, keyframes, options });
      return { finished: open } as any;
    };
    await load(["a", "c"]);
    await Promise.resolve();
    expect(rows(host)[1]).toBe(before[2]);
    expect(before[1].parentElement).toBe(document.body);
    expect(before[1].inert).toBe(true);
    const fade = calls.find((c) => c.el === before[1])!;
    expect(fade.keyframes).toEqual([{ opacity: 1 }, { opacity: 0 }]);
    const slide = calls.find((c) => c.el === before[2])!;
    expect(slide.keyframes).toEqual([{ transform: "translate(0px, 56px)" }, { transform: "none" }]);
    expect(slide.options.delay).toBe(150);
    finish();
    await Promise.resolve();
    await Promise.resolve();
    expect(before[1].isConnected).toBe(false);
  });

  test("an accepted request turns into an album row without rebuilding the list, even with no albums yet", async () => {
    const { host, before } = await mount([], [ask("waiting")]);
    const list = host.querySelector("ul[aria-label='Your albums']");
    expect(list).not.toBeNull();
    await load(["x"], []);
    await Promise.resolve();
    expect(host.querySelector("ul[aria-label='Your albums']")).toBe(list);
    expect(host.textContent).not.toContain("Loading…");
    expect(calls.find((c) => c.el === before[0])!.keyframes).toEqual([
      { opacity: 1 },
      { opacity: 0 },
    ]);
    const enter = own(host).find((c) => (c.el as HTMLElement).dataset.motionKey === "album:x")!;
    expect(enter.keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);
  });

  test("an invite arriving at the top slides the albums down", async () => {
    const { host, before } = await mount(["a", "b"]);
    await load(["a", "b"], [], [offer]);
    await Promise.resolve();
    const now = rows(host);
    expect(now[1]).toBe(before[0]);
    expect(now[2]).toBe(before[1]);
    const enter = own(host).find((c) =>
      (c.el as HTMLElement).dataset.motionKey?.startsWith("invite:"),
    )!;
    expect(enter.keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    const slide = calls.find((c) => c.el === before[0])!;
    expect(slide.keyframes).toEqual([
      { transform: "translate(0px, -56px)" },
      { transform: "none" },
    ]);
  });

  test("a refresh with the same rows animates nothing", async () => {
    const { host, before } = await mount(["a", "b"]);
    await load(["a", "b"]);
    await Promise.resolve();
    expect(own(host)).toHaveLength(0);
    rows(host).forEach((row, i) => expect(row).toBe(before[i]));
  });
});

describe("Your albums page motion", () => {
  type Call = { el: Element; keyframes: any; options: any };
  let calls: Call[];
  const saved = {
    animate: Element.prototype.animate,
    getAnimations: Element.prototype.getAnimations,
    rect: Element.prototype.getBoundingClientRect,
    matchMedia: window.matchMedia,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
  };
  const d1 = { id: "d1", name: "Old", adminName: "Nils" };

  const H = (el: Element): number =>
    el.matches('[data-motion-key^="notice:"]')
      ? 48
      : el.matches("li") || el.children.length === 0
        ? 56
        : [...el.children].reduce((n, c) => n + H(c), 0);
  const top = (el: Element): number => {
    const p = el.parentElement;
    if (!p) return 0;
    const i = [...p.children].indexOf(el);
    return top(p) + [...p.children].slice(0, i).reduce((n, c) => n + H(c), 0);
  };

  beforeEach(() => {
    calls = [];
    Element.prototype.animate = function (this: Element, keyframes: any, options: any) {
      calls.push({ el: this, keyframes, options });
      return { finished: new Promise(() => {}) } as any;
    };
    Element.prototype.getAnimations = (() => []) as any;
    Element.prototype.getBoundingClientRect = function (this: Element) {
      return { top: top(this), left: 0, width: 300, height: H(this) } as any;
    };
    window.matchMedia = (() => ({ matches: false })) as any;
    window.innerWidth = 400;
    window.innerHeight = 4000;
  });

  afterEach(() => {
    Element.prototype.animate = saved.animate;
    Element.prototype.getAnimations = saved.getAnimations;
    Element.prototype.getBoundingClientRect = saved.rect;
    window.matchMedia = saved.matchMedia;
    window.innerWidth = saved.innerWidth;
    window.innerHeight = saved.innerHeight;
    document.body.replaceChildren();
  });

  type Data = { folders: string[]; archived?: string[]; deleted?: (typeof d1)[] };
  const loadAll = async ({ folders: ids, archived = [], deleted = [] }: Data) => {
    mock.folders.mockResolvedValue([
      null,
      {
        folders: ids.map(album),
        archived: archived.map(album),
        deleted,
        asks: [],
        offers: [],
        activeFolderId: ids[0] ?? null,
      },
    ]);
    folders.refresh();
    await vi.waitFor(() => {
      const c = foldersActor.snapshot().context;
      expect(c.folders.map((f) => f.id)).toEqual(ids);
      expect(c.archived.map((f) => f.id)).toEqual(archived);
      expect(c.deleted).toEqual(deleted);
    });
    await foldersActor.settled();
  };
  const flush = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };
  const mount = async (data: Data) => {
    await loadAll(data);
    const host = document.createElement("div");
    document.body.append(host);
    render(albumsPanel(), host);
    await flush();
    calls = [];
    const byKey = (k: string) => host.querySelector<HTMLElement>(`[data-motion-key="${k}"]`)!;
    const callsOn = (el: Element) => calls.filter((c) => c.el === el);
    return { host, byKey, callsOn };
  };
  const change = async (data: Data) => {
    await loadAll(data);
    await flush();
    await flush();
  };
  const fadedOut = (el: HTMLElement, callsOn: (e: Element) => Call[]) => {
    expect(el.parentElement).toBe(document.body);
    expect(el.inert).toBe(true);
    expect(callsOn(el)[0].keyframes).toEqual([{ opacity: 1 }, { opacity: 0 }]);
  };
  const slid = (c: Call[], dy: number, delay?: number) => {
    expect(c).toHaveLength(1);
    expect(c[0].keyframes).toEqual([
      { transform: `translate(0px, ${dy}px)` },
      { transform: "none" },
    ]);
    if (delay !== undefined) expect(c[0].options.delay).toBe(delay);
  };

  test("a notice for a deleted album fades in and the albums slide down without moving twice", async () => {
    const { byKey, callsOn } = await mount({ folders: ["a", "b"] });
    const rowA = byKey("album:a");
    const rowB = byKey("album:b");
    await change({ folders: ["a"], deleted: [{ ...d1, id: "b" }] });
    expect(callsOn(byKey("notice:b"))[0].keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    slid(callsOn(byKey("section:albums")), -48);
    fadedOut(rowB, callsOn);
    expect(callsOn(rowA)).toHaveLength(0);
    expect(byKey("album:a")).toBe(rowA);
  });

  test("dismissing a notice fades it out and slides the page up", async () => {
    const { byKey, callsOn } = await mount({ folders: ["a"], deleted: [d1] });
    const notice = byKey("notice:d1");
    await change({ folders: ["a"] });
    fadedOut(notice, callsOn);
    for (const k of ["section:hint", "section:albums", "section:new"]) {
      slid(callsOn(byKey(k)), 48, 150);
    }
    expect(callsOn(byKey("album:a"))).toHaveLength(0);
  });

  test("Undo on the only archived album fades it into the list and fades the Archived card out", async () => {
    const { byKey, callsOn } = await mount({ folders: ["a"], archived: ["z"] });
    const card = byKey("section:archived");
    const newCard = byKey("section:new");
    await change({ folders: ["a", "z"] });
    expect(callsOn(byKey("album:z"))[0].keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    fadedOut(card, callsOn);
    expect(byKey("section:new")).toBe(newCard);
    slid(callsOn(newCard), 56, 150);
    expect(callsOn(byKey("album:a"))).toHaveLength(0);
  });

  test("Restore under an open Archived fades the row out and slides the rest", async () => {
    const { byKey, callsOn } = await mount({ folders: ["a"], archived: ["y", "z"] });
    const card = byKey("section:archived") as HTMLDetailsElement;
    card.open = true;
    const rowY = byKey("archived:y");
    const rowZ = byKey("archived:z");
    await change({ folders: ["a", "y"], archived: ["z"] });
    expect(byKey("section:archived")).toBe(card);
    expect(card.open).toBe(true);
    slid(callsOn(card), -56);
    fadedOut(rowY, callsOn);
    expect(byKey("archived:z")).toBe(rowZ);
    slid(callsOn(rowZ), 56, 150);
    expect(callsOn(byKey("album:y"))[0].keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    expect(callsOn(byKey("section:new"))).toHaveLength(0);
  });

  test("the first load and a refresh with the same rows animate nothing", async () => {
    await loadAll({ folders: [] });
    const host = document.createElement("div");
    document.body.append(host);
    render(albumsPanel(), host);
    await flush();
    calls = [];
    const data = { folders: ["a"], archived: ["z"], deleted: [d1] };
    await loadAll(data);
    await vi.waitFor(() =>
      expect(host.querySelector('[data-motion-key="album:a"]')).not.toBeNull(),
    );
    await flush();
    await flush();
    expect(calls.filter((c) => host.contains(c.el))).toHaveLength(0);
    await loadAll(data);
    await flush();
    await flush();
    expect(calls.filter((c) => host.contains(c.el))).toHaveLength(0);
  });
});

describe("archived and deleted sections", () => {
  test("Archived shows with its count and Restore, and a notice has Dismiss", async () => {
    const host = document.createElement("div");
    render(albumsPanel(), host);
    mock.folders.mockResolvedValue([
      null,
      {
        folders: [album("a")],
        archived: [album("z")],
        deleted: [
          { id: "d1", name: "Old", adminName: "Nils" },
          { id: "d2", name: "Newer", adminName: "Nils" },
        ],
        activeFolderId: "a",
      },
    ]);
    folders.refresh();
    await vi.waitFor(() => expect(host.querySelector("details")).not.toBeNull());
    expect(host.querySelector("summary")?.textContent?.trim()).toBe("Archived (1)");
    expect(host.querySelector("[aria-label='Restore Album z']")).not.toBeNull();
    const notices = [...host.querySelectorAll("[role=status]")].map((n) => n.textContent?.trim());
    expect(notices).toEqual([
      "Nils deleted “Newer”. The album and its photos were removed from this phone.",
      "Nils deleted “Old”. The album and its photos were removed from this phone.",
    ]);
    expect(host.querySelector("[aria-label='Dismiss notice about Old']")).not.toBeNull();
  });

  test("the summary counts requests waiting on archived albums", () => {
    expect(archivedSummary(2, 0)).toBe("Archived (2)");
    expect(archivedSummary(2, 3)).toBe("Archived (2) · 3 waiting");
  });
});

describe("an album that vanishes under an open page", () => {
  test("routes only for an id that was listed before and is listed no more", () => {
    const before = new Set(["a", "b"]);
    expect(albumVanished(before, ["a"], "b")).toBe(true);
    expect(albumVanished(before, ["a", "b"], "b")).toBe(false);
    expect(albumVanished(before, ["a"], "never")).toBe(false);
    expect(albumVanished(before, [], null)).toBe(false);
  });
});
