// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { render } from "lit-html";
import type { SyncStatus } from "@justus/core";
import { copy } from "../copy/copy";
import { friends, friendsActor } from "../machines/friends-machine";
import { people, peopleActor } from "../machines/people-machine";
import { statusSeen, syncActor } from "../machines/sync-machine";
import { requests, requestsActor } from "../machines/requests-machine";
import { folders } from "../machines/folders-machine";
import { gateway } from "../gateway";
import { gallery } from "../machines/gallery-machine";
import {
  acceptAllToast,
  albumMenuItems,
  removedDeleteSheet,
  albumView,
  answerToast,
  deleteSheet,
  leaveDetail,
  removeDetail,
} from "./album";
import { toast } from "./toast";
import { confirmAction } from "./confirm";

vi.mock("./toast", () => ({ toast: vi.fn() }));
vi.mock("./confirm", () => ({ confirmAction: vi.fn().mockResolvedValue(true) }));

vi.mock("../gateway", () => ({
  gateway: {
    friends: {
      list: vi.fn(async () => [null, { friends: [] }]),
      add: vi.fn(async (identity: string, name: string) => [null, { friend: { identity, name } }]),
    },
    folders: vi.fn(),
    requests: vi.fn().mockResolvedValue([null, { requests: [] }]),
    removeMember: vi.fn(),
    makeMember: vi.fn().mockResolvedValue([null, { ok: true }]),
    makeViewer: vi.fn().mockResolvedValue([null, { ok: true }]),
    takeBackOffer: vi.fn().mockResolvedValue([null, { ok: true }]),
    respond: vi.fn().mockResolvedValue([null, { ok: true }]),
    logs: { view: vi.fn(), clear: vi.fn() },
    list: vi.fn().mockResolvedValue([null, { photos: [] }]),
    add: vi.fn(),
    upload: vi.fn(),
    remove: vi.fn(),
  },
}));

/** Text of an element with whitespace runs collapsed, as a browser lays it out. */
const flat = (el: Element) => (el.textContent ?? "").replace(/\s+/g, " ");

const status = {
  name: "Me",
  peers: 1,
  photos: 0,
  driveKey: "d",
  discoveryKey: "dk",
  members: [
    { key: "k0", name: "Me", admin: true, connected: true },
    { key: "k1", name: "Kim", admin: false, connected: true, identity: "i1" },
    { key: "k2", name: "Zed", admin: false, connected: false, identity: "i2" },
  ],
  folder: { id: "f1", name: "Trip", role: "creator", shareKey: "s", driveKey: "d", members: 3 },
} as unknown as SyncStatus;

const memberRows = (host: HTMLElement) => [
  ...host.querySelectorAll<HTMLLIElement>("ul.divide-y > li"),
];

const controls = (row: Element) => [...row.querySelectorAll("button")].map((b) => flat(b).trim());
const buttonNamed = (host: ParentNode, re: RegExp) =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => re.test(flat(b).trim()));

describe("Make Viewer", () => {
  const viewerStatus = {
    ...status,
    members: [
      { key: "k0", name: "Me", admin: true, connected: true },
      { key: "k1", name: "Nils", admin: false, connected: false, identity: "i1" },
      { key: "k2", name: "Vi", admin: false, connected: false, identity: "i2", viewer: true },
    ],
  } as unknown as SyncStatus;
  const open = () => {
    syncActor.send(statusSeen.create({ status: viewerStatus }));
    people.open();
    const host = document.createElement("div");
    render(albumView("f1"), host);
    return host;
  };

  test("a Collaborator row shows Make Nils a Viewer before Remove Nils", () => {
    const row = memberRows(open()).find((r) => r.textContent?.includes("Nils"));
    expect(controls(row!).slice(-2)).toEqual(["Make Nils a Viewer", "Remove Nils"]);
  });

  test("confirm copy names the person", async () => {
    vi.mocked(confirmAction).mockResolvedValueOnce(false);
    buttonNamed(open(), /^Make Nils a Viewer$/)?.click();
    await vi.waitFor(() =>
      expect(confirmAction).toHaveBeenCalledWith({
        title: "Make Nils a Viewer?",
        detail:
          "Nils keeps seeing every photo but can't add more. The photos Nils already added stay in the album.",
        confirmLabel: "Make Viewer",
        cancelLabel: "Keep as Collaborator",
      }),
    );
  });

  test("confirming calls makeViewer; cancelling does not", async () => {
    vi.mocked(confirmAction).mockResolvedValueOnce(false);
    const host = open();
    const button = () => buttonNamed(host, /^Make Nils a Viewer$/);
    button()?.click();
    await vi.waitFor(() => expect(confirmAction).toHaveBeenCalled());
    expect(gateway.makeViewer).not.toHaveBeenCalled();
    button()?.click();
    await vi.waitFor(() => expect(gateway.makeViewer).toHaveBeenCalledWith("f1", "k1"));
  });

  test("a Viewer row and the Admin's own row have no Make a Viewer button", () => {
    const rows = memberRows(open());
    for (const name of ["Vi", "Me"]) {
      const row = rows.find((r) => r.querySelector("p")?.textContent?.trim().startsWith(name));
      expect(buttonNamed(row!, /^Make .* a Viewer$/)).toBeUndefined();
    }
  });

  test("an Admin sees no action line on their own row or another Admin's row", () => {
    syncActor.send(
      statusSeen.create({
        status: {
          ...viewerStatus,
          members: [
            { key: "k0", name: "Me", admin: true, connected: true },
            { key: "k3", name: "Ada", admin: true, connected: true, identity: "i3" },
            { key: "k1", name: "Nils", admin: false, connected: false, identity: "i1" },
          ],
        } as unknown as SyncStatus,
      }),
    );
    people.open();
    const host = document.createElement("div");
    render(albumView("f1"), host);
    const rows = memberRows(host);
    for (const name of ["Me", "Ada"]) {
      const row = rows.find((r) => r.querySelector("p")?.textContent?.trim().startsWith(name));
      expect(row!.childElementCount).toBe(1);
    }
    const nils = rows.find((r) => r.textContent?.includes("Nils"));
    expect(nils!.childElementCount).toBe(2);
  });

  test("no member-row button has an aria-label", () => {
    const host = open();
    expect(memberRows(host).flatMap((r) => [...r.querySelectorAll("button[aria-label]")])).toEqual(
      [],
    );
  });

  test("Remove is a red ghost button; the role button is a plain ghost button", () => {
    const host = open();
    const remove = buttonNamed(host, /^Remove Nils$/)!;
    const role = buttonNamed(host, /^Make Nils a Viewer$/)!;
    for (const b of [remove, role]) {
      expect(b.classList.contains("ui-btn-ghost")).toBe(true);
      expect(b.classList.contains("ui-btn-primary")).toBe(false);
    }
    expect(remove.classList.contains("text-danger-fg")).toBe(true);
    expect(role.classList.contains("text-danger-fg")).toBe(false);
  });

  test.each(["member", "reader"] as const)("a %s sees rows with no action line", (role) => {
    syncActor.send(
      statusSeen.create({
        status: {
          ...viewerStatus,
          folder: { ...viewerStatus.folder, role },
        } as unknown as SyncStatus,
      }),
    );
    people.open();
    const host = document.createElement("div");
    render(albumView("f1"), host);
    for (const row of memberRows(host)) {
      expect(row.childElementCount).toBe(1);
      expect(buttonNamed(row, /^(Remove|Make|Let) /)).toBeUndefined();
    }
  });
});

describe("album people", () => {
  test("naming a friend changes that row's label and keeps every row element", async () => {
    syncActor.send(statusSeen.create({ status }));
    people.open();
    const host = document.createElement("div");
    render(albumView("f1"), host);
    const before = memberRows(host);
    expect(before).toHaveLength(3);
    expect(before[1].textContent).toContain("Kim");

    friends.open({ identity: "i1", ownName: "Kim" });
    friends.add();
    friends.type("Kimmy");
    friends.save();
    await friendsActor.settled();
    await vi.waitFor(() => expect(memberRows(host)[1].textContent).toContain("Kimmy"));
    const after = memberRows(host);
    expect(after).toHaveLength(3);
    after.forEach((row, i) => expect(row).toBe(before[i]));
  });

  describe("Add to friends hint", () => {
    const hint = "Add to friends ›";
    const rows = (members: unknown[]) => {
      syncActor.send(statusSeen.create({ status: { ...status, members } as never }));
      people.open();
      const host = document.createElement("div");
      render(albumView("f1"), host);
      return memberRows(host);
    };
    const me = { key: "k0", name: "Me", admin: true, connected: true, identity: "id-me" };

    test("shows on a tappable non-friend row, and nowhere else", () => {
      const r = rows([
        me,
        { key: "k1", name: "Qux", admin: false, connected: true, identity: "id-q" },
        { key: "k2", name: "Nox", admin: false, connected: true },
      ]);
      expect(flat(r[0])).not.toContain(hint);
      expect(flat(r[1])).toContain(hint);
      expect(r[1].querySelector("button")?.textContent).toContain(hint);
      expect(flat(r[2])).not.toContain(hint);
    });

    test("hidden once the person is a friend", async () => {
      friends.open({ identity: "id-q", ownName: "Qux" });
      friends.add();
      friends.type("Qux");
      friends.save();
      await friendsActor.settled();
      const r = rows([
        me,
        { key: "k1", name: "Qux", admin: false, connected: true, identity: "id-q" },
      ]);
      expect(flat(r[1])).not.toContain(hint);
    });

    test("same for a Viewer row", () => {
      const r = rows([
        me,
        { key: "k1", name: "Vi", admin: false, viewer: true, connected: true, identity: "id-v" },
      ]);
      expect(flat(r[1])).toContain(hint);
    });
  });

  test("a member with a saved friend's name, not saved themselves, is marked", async () => {
    friends.open({ identity: "id-ben", ownName: "Ben" });
    friends.add();
    friends.type("Dad");
    friends.save();
    await friendsActor.settled();
    syncActor.send(
      statusSeen.create({
        status: {
          ...status,
          members: [
            { key: "k0", name: "Me", admin: true, connected: true },
            { key: "k1", name: "dad", admin: false, connected: true, identity: "id-x" },
          ],
        },
      }),
    );
    people.open();
    const host = document.createElement("div");
    render(albumView("f1"), host);
    await vi.waitFor(() => expect(host.textContent).toContain("Not your friend Dad"));
    expect(memberRows(host)[1].textContent).toContain("Not your friend Dad");
    expect(memberRows(host)[0].textContent).not.toContain("Not your friend");
  });

  test("asking for the QR code sets the flag the invite panel reads", () => {
    people.close();
    people.open();
    const host = document.createElement("div");
    render(albumView("f1"), host);
    expect(peopleActor.snapshot().context.qrShown).toBe(false);
    people.showQr();
    expect(peopleActor.snapshot().context.qrShown).toBe(true);
    people.close();
    expect(peopleActor.snapshot().context.qrShown).toBe(false);
  });
});

describe("album people motion", () => {
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

  const withMembers = (members: unknown[]) =>
    ({
      ...status,
      members,
      folder: { ...status.folder, members: members.length },
    }) as unknown as SyncStatus;

  const mountAlbum = () => {
    syncActor.send(statusSeen.create({ status }));
    people.open();
    const host = document.createElement("div");
    document.body.append(host);
    render(albumView("f1"), host);
    const before = memberRows(host);
    calls = [];
    return { host, before };
  };

  test("a member who joins fades in and the rows already there keep their elements", async () => {
    const { host, before } = mountAlbum();
    const ana = { key: "k3", name: "Ana", admin: false, connected: true, identity: "i3" };
    syncActor.send(statusSeen.create({ status: withMembers([...status.members, ana]) }));
    await vi.waitFor(() => expect(memberRows(host)).toHaveLength(4));
    await Promise.resolve();
    memberRows(host)
      .slice(0, 3)
      .forEach((row, i) => expect(row).toBe(before[i]));
    // Hosts from earlier tests stay subscribed to the shared actors.
    const mine = calls.filter((c) => host.contains(c.el));
    expect(mine).toHaveLength(1);
    expect((mine[0].el as HTMLElement).dataset.motionKey).toBe("k3");
    expect(mine[0].keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);
  });

  test("a removed member fades out in place and the rows below slide up", async () => {
    const { host, before } = mountAlbum();
    const [k0, , k2] = status.members;
    syncActor.send(statusSeen.create({ status: withMembers([k0, k2]) }));
    await vi.waitFor(() => expect(memberRows(host)).toHaveLength(2));
    expect(memberRows(host)[1]).toBe(before[2]);
    expect(before[1].parentElement).toBe(document.body);
    expect(before[1].inert).toBe(true);
    const fade = calls.find((c) => c.el === before[1])!;
    expect(fade.keyframes).toEqual([{ opacity: 1 }, { opacity: 0 }]);
    const slide = calls.find((c) => c.el === before[2])!;
    expect(slide.keyframes).toEqual([{ transform: "translate(0px, 56px)" }, { transform: "none" }]);
    expect(slide.options.delay).toBe(150);
    await Promise.resolve();
    await Promise.resolve();
    expect(before[1].isConnected).toBe(false);
  });
});

describe("album join requests", () => {
  const ask = (requesterKey: string, viaInvite: boolean, checkCode?: string) => ({
    requesterIdentity: undefined as string | undefined,
    folderId: "f1",
    folderName: "Trip",
    requesterKey,
    requesterName: requesterKey,
    shareKey: "s",
    requestedAt: Date.now(),
    ...(viaInvite ? { viaInvite } : {}),
    ...(checkCode ? { checkCode } : {}),
  });

  async function show(list: ReturnType<typeof ask>[]) {
    vi.mocked(gateway.requests).mockResolvedValue([null, { requests: list }] as never);
    vi.mocked(gateway.respond).mockClear();
    syncActor.send(statusSeen.create({ status }));
    people.open();
    requests.refresh();
    const host = document.createElement("div");
    render(albumView("f1"), host);
    await vi.waitFor(() => expect(host.textContent).toContain("wants to join"));
    return host;
  }
  const name = (b: HTMLElement) => {
    const c = b.cloneNode(true) as HTMLElement;
    for (const h of c.querySelectorAll('[aria-hidden="true"]')) h.remove();
    return c.textContent?.trim();
  };
  const button = (host: HTMLElement, text: string) =>
    [...host.querySelectorAll("button")].find((b) => name(b) === text);

  test("rows show their check code and the section says what it is for", async () => {
    const host = await show([
      { ...ask("a", true, "maple river stone"), requesterName: "Ben" },
      { ...ask("b", true, "lamp ocean tiger"), requesterName: "Ben" },
    ]);
    const rows = [...host.querySelectorAll<HTMLElement>('li[data-motion-key^="request:"]')];
    expect(flat(rows[0]!)).toContain("Check code maple river stone");
    expect(flat(rows[1]!)).toContain("Check code lamp ocean tiger");
    expect(host.textContent).toContain("Not sure who it is?");
  });

  test("a request from a saved friend shows your name for them and Friend", async () => {
    friends.open({ identity: "id-ben", ownName: "Ben" });
    friends.add();
    friends.type("Dad");
    friends.save();
    await friendsActor.settled();
    const host = await show([
      { ...ask("a", true), requesterName: "Ben", requesterIdentity: "id-ben" },
    ]);
    await vi.waitFor(() => expect(flat(host)).toContain("Dad wants to join"));
    const row = host.querySelector<HTMLElement>('li[data-motion-key^="request:"]')!;
    expect(row.textContent).toContain("Friend");
    expect(row.textContent).toContain("Ben");
  });

  test("a stranger with a saved friend's name is marked and left out of Accept all", async () => {
    friends.open({ identity: "id-ben", ownName: "Ben" });
    friends.add();
    friends.type("Dad");
    friends.save();
    await friendsActor.settled();
    const host = await show([
      {
        ...ask("a", true, "maple river stone"),
        requesterName: "Ben",
        requesterIdentity: "id-ben",
      },
      { ...ask("b", true, "lamp ocean tiger"), requesterName: "dad", requesterIdentity: "id-x" },
    ]);
    await vi.waitFor(() => expect(host.textContent).toContain("Not your friend Dad"));
    const rows = [...host.querySelectorAll<HTMLElement>('li[data-motion-key^="request:"]')];
    const rowB = rows.find((r) => flat(r).includes("Check code lamp ocean tiger"))!;
    const rowA = rows.find((r) => flat(r).includes("Check code maple river stone"))!;
    expect(rowB.textContent).toContain("Not your friend Dad");
    expect(rowA.textContent).not.toContain("Not your friend");
    expect(host.textContent).toContain("typed a friend's name.");
    expect(host.textContent).not.toContain("Not sure who it is?");
    expect(button(host, "Accept all 1 as Viewers")).toBeUndefined();
    expect(
      [...host.querySelectorAll("button")].some((b) => name(b)?.startsWith("Accept all")),
    ).toBe(false);
    expect(
      [...host.querySelectorAll("button")].filter((b) => name(b) === "Accept as Viewer"),
    ).toHaveLength(2);
  });

  test("without codes there is no check code text", async () => {
    const host = await show([ask("nils", true)]);
    expect(host.textContent).not.toContain("Check code");
    expect(host.textContent).not.toContain("Not sure who it is?");
  });

  test("an invite request offers Accept as Viewer, Accept as Collaborator and Decline, each with its meaning; Viewer sends reader", async () => {
    const host = await show([ask("nils", true)]);
    expect(
      [...host.querySelectorAll<HTMLElement>('li[data-motion-key^="request:"] button')].map(name),
    ).toEqual(["Accept as Viewer", "Accept as Collaborator", "Decline"]);
    expect(host.textContent).toContain("Sees every photo, can't add any");
    expect(host.textContent).toContain("Sees every photo and can add their own");
    expect(host.textContent).not.toContain("A Viewer sees every photo. A Collaborator");
    expect(button(host, "Accept")).toBeUndefined();
    expect(button(host, "Accept as Viewer")!.className).toBe(
      button(host, "Accept as Collaborator")!.className,
    );
    button(host, "Accept as Viewer")!.click();
    await vi.waitFor(() =>
      expect(gateway.respond).toHaveBeenCalledWith("f1", "nils", true, "reader"),
    );
  });

  test("Accept as Collaborator sends the member role", async () => {
    const host = await show([ask("nils", true)]);
    button(host, "Accept as Collaborator")!.click();
    await vi.waitFor(() =>
      expect(gateway.respond).toHaveBeenCalledWith("f1", "nils", true, "member"),
    );
  });

  test("the accept toast waits for the answer", async () => {
    vi.mocked(toast).mockClear();
    const host = await show([ask("nils", true)]);
    let resolve!: (v: unknown) => void;
    vi.mocked(gateway.respond).mockReturnValueOnce(new Promise((r) => (resolve = r)) as never);
    button(host, "Accept as Viewer")!.click();
    await vi.waitFor(() => expect(gateway.respond).toHaveBeenCalled());
    expect(toast).not.toHaveBeenCalled();
    resolve([null, { ok: true }]);
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith("nils is in as a Viewer"));
    expect(toast).toHaveBeenCalledTimes(1);
    await requestsActor.settled();
  });

  test("the decline toast waits for the answer and names who", async () => {
    vi.mocked(toast).mockClear();
    const host = await show([ask("nils", true), ask("ola", true)]);
    let resolve!: (v: unknown) => void;
    vi.mocked(gateway.respond).mockReturnValueOnce(new Promise((r) => (resolve = r)) as never);
    button(host, "Decline")!.click();
    await vi.waitFor(() => expect(gateway.respond).toHaveBeenCalled());
    expect(toast).not.toHaveBeenCalled();
    resolve([null, { ok: true }]);
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith("Declined nils"));
    expect(toast).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("ola");
    await requestsActor.settled();
  });

  test("a failed answer shows why on that card, with no toast; Retry sends it again", async () => {
    vi.mocked(toast).mockClear();
    const host = await show([ask("nils", true), ask("ola", true)]);
    vi.mocked(gateway.respond)
      .mockResolvedValueOnce([new Error("invoke timeout for x"), null] as never)
      .mockResolvedValueOnce([null, { ok: true }] as never);
    const card = (k: string) =>
      [...host.querySelectorAll("li")].find((li) => flat(li).includes(`${k} wants`))!;
    [...card("nils").querySelectorAll("button")]
      .find((b) => name(b) === "Accept as Viewer")!
      .click();
    await vi.waitFor(() =>
      expect(card("nils").textContent).toContain(
        "Couldn't connect. Check your internet and try again.",
      ),
    );
    expect(card("nils").querySelector("[role=alert]")).not.toBeNull();
    expect(card("ola").querySelector("[role=alert]")).toBeNull();
    expect(toast).not.toHaveBeenCalled();
    [...card("nils").querySelectorAll("button")].find((b) => name(b) === "Retry")!.click();
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith("nils is in as a Viewer"));
    expect(gateway.respond).toHaveBeenCalledTimes(2);
    expect(gateway.respond).toHaveBeenLastCalledWith("f1", "nils", true, "reader");
    await requestsActor.settled();
    await vi.waitFor(() => expect(card("nils")).toBeUndefined());
  });

  test("two invite requests show Accept all 2 as Viewers above the list", async () => {
    const host = await show([ask("nils", true), ask("ola", true)]);
    const all = button(host, "Accept all 2 as Viewers")!;
    expect(all).toBeDefined();
    expect(all.compareDocumentPosition(host.querySelector("li")!)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(host.textContent).toContain("They can see the photos but not add or remove any.");
    for (const list of [[ask("nils", true)], [ask("nils", true), ask("ola", false)]]) {
      const h = await show(list);
      expect([...h.querySelectorAll("button")].some((b) => name(b)?.startsWith("Accept all"))).toBe(
        false,
      );
    }
  });

  test("Accept all sends a Viewer answer to each, disables the buttons, then one toast", async () => {
    vi.mocked(toast).mockClear();
    const host = await show([ask("nils", true), ask("ola", true)]);
    const resolvers: ((v: unknown) => void)[] = [];
    vi.mocked(gateway.respond).mockImplementation(
      () => new Promise((r) => resolvers.push(r)) as never,
    );
    button(host, "Accept all 2 as Viewers")!.click();
    await vi.waitFor(() => expect(resolvers).toHaveLength(1));
    await vi.waitFor(() => {
      expect(button(host, "Accept all 2 as Viewers")?.disabled).toBe(true);
      const rowButtons = [
        ...host.querySelectorAll<HTMLButtonElement>('li[data-motion-key^="request:"] button'),
      ];
      expect(rowButtons.every((b) => b.disabled)).toBe(true);
    });
    resolvers[0]([null, { ok: true }]);
    await vi.waitFor(() => expect(resolvers).toHaveLength(2));
    expect(toast).not.toHaveBeenCalled();
    resolvers[1]([null, { ok: true }]);
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith("2 people are in as Viewers"));
    expect(toast).toHaveBeenCalledTimes(1);
    expect(vi.mocked(gateway.respond).mock.calls).toEqual([
      ["f1", "nils", true, "reader"],
      ["f1", "ola", true, "reader"],
    ]);
    await requestsActor.settled();
    vi.mocked(gateway.respond).mockResolvedValue([null, { ok: true }] as never);
  });

  test("a dropped connection stops Accept all: reason and Retry, no toast; Retry finishes with one toast", async () => {
    vi.mocked(toast).mockClear();
    const host = await show([ask("nils", true), ask("ola", true)]);
    vi.mocked(gateway.respond)
      .mockResolvedValueOnce([null, { ok: true }] as never)
      .mockResolvedValueOnce([new Error("invoke timeout for x"), null] as never)
      .mockResolvedValueOnce([null, { ok: true }] as never);
    button(host, "Accept all 2 as Viewers")!.click();
    await vi.waitFor(() => expect(button(host, "Retry")).toBeDefined());
    expect(host.querySelector("[role=alert]")?.textContent).toContain(
      "Couldn't connect. Check your internet and try again.",
    );
    expect(toast).not.toHaveBeenCalled();
    button(host, "Retry")!.click();
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith("2 people are in as Viewers"));
    expect(toast).toHaveBeenCalledTimes(1);
    await requestsActor.settled();
  });

  test("Decline lowers the count and the button goes at one", async () => {
    const host = await show([ask("nils", true), ask("ola", true), ask("kim", true)]);
    vi.mocked(gateway.respond).mockResolvedValue([null, { ok: true }] as never);
    const decline = (k: string) =>
      [...host.querySelectorAll("li")]
        .find((li) => flat(li).includes(`${k} wants`))!
        .querySelectorAll("button");
    [...decline("nils")].find((b) => name(b) === "Decline")!.click();
    await vi.waitFor(() => expect(button(host, "Accept all 2 as Viewers")).toBeDefined());
    [...decline("ola")].find((b) => name(b) === "Decline")!.click();
    await vi.waitFor(() => expect(button(host, "Accept all 2 as Viewers")).toBeUndefined());
    expect(
      [...host.querySelectorAll("button")].some((b) => name(b)?.startsWith("Accept all")),
    ).toBe(false);
    await requestsActor.settled();
    vi.mocked(gateway.respond).mockResolvedValue([null, { ok: true }] as never);
  });

  test("acceptAllToast: singular and plural", () => {
    expect(acceptAllToast(1)).toBe("1 person is in as a Viewer");
    expect(acceptAllToast(13)).toBe("13 people are in as Viewers");
  });

  test("answerToast: a No names who was declined; Viewer, Collaborator and plain Accept wording", () => {
    const a = { requesterName: "Nils", approve: true, role: "member" as const, viaInvite: false };
    expect(answerToast({ ...a, approve: false })).toBe("Declined Nils");
    expect(answerToast({ ...a, approve: false, requesterName: "" })).toBe("Declined that request");
    expect(answerToast({ ...a, approve: false, requesterName: copy("requests.they") })).toBe(
      "Declined that request",
    );
    expect(answerToast({ ...a, role: "reader", viaInvite: true })).toBe("Nils is in as a Viewer");
    expect(answerToast({ ...a, viaInvite: true })).toBe("Nils is in as a Collaborator");
    expect(answerToast(a)).toBe("Nils is in");
  });

  test("a plain request keeps a single Accept that sends the member role", async () => {
    const host = await show([ask("ola", false)]);
    expect(host.textContent).not.toContain("Sees every photo");
    expect(button(host, "Accept as Viewer")).toBeUndefined();
    button(host, "Accept")!.click();
    await vi.waitFor(() =>
      expect(gateway.respond).toHaveBeenCalledWith("f1", "ola", true, "member"),
    );
  });
});

describe("album viewer rows", () => {
  test("a Viewer row says Viewer with a presence dot and Remove last", () => {
    const viewerStatus = {
      ...status,
      members: [
        { key: "k0", name: "Me", admin: true, connected: true },
        { key: "k1", name: "Nils", admin: false, connected: true, identity: "i1", viewer: true },
      ],
    } as unknown as SyncStatus;
    syncActor.send(statusSeen.create({ status: viewerStatus }));
    people.open();
    const host = document.createElement("div");
    render(albumView("f1"), host);
    const row = memberRows(host)[1];
    expect(row.textContent).toContain("Viewer · sees every photo, adds none");
    expect(row.textContent).toContain("connected");
    expect(row.querySelector("span.h-1\\.5")).not.toBeNull();
    expect(controls(row).slice(-2)).toEqual(["Let Kimmy add photos", "Remove Kimmy"]);
  });

  test("Remove on a Viewer asks with the Viewer text", async () => {
    const viewerStatus = {
      ...status,
      members: [
        { key: "k0", name: "Me", admin: true, connected: true },
        { key: "k1", name: "Nils", admin: false, connected: true, identity: "i1", viewer: true },
      ],
    } as unknown as SyncStatus;
    syncActor.send(statusSeen.create({ status: viewerStatus }));
    people.open();
    vi.mocked(confirmAction).mockResolvedValueOnce(false);
    const host = document.createElement("div");
    render(albumView("f1"), host);
    const remove = buttonNamed(memberRows(host)[1], /^Remove /);
    remove?.click();
    await vi.waitFor(() =>
      expect(confirmAction).toHaveBeenLastCalledWith({
        title: "Remove Kimmy?",
        detail:
          "Kimmy won't see photos added from now on. Kimmy keeps the photos already on their phone and sees they're no longer in the album. Everyone else stays in the album and keeps their photos; this reaches their phones the next time they connect to yours.",
        confirmLabel: "Remove",
        tone: "danger",
      }),
    );
  });

  test("Remove on a Collaborator says their photos leave", async () => {
    vi.mocked(confirmAction).mockResolvedValueOnce(false);
    const host = document.createElement("div");
    syncActor.send(statusSeen.create({ status }));
    people.open();
    render(albumView("f1"), host);
    const remove = buttonNamed(memberRows(host)[1], /^Remove /);
    remove?.click();
    await vi.waitFor(() =>
      expect(confirmAction).toHaveBeenLastCalledWith(
        expect.objectContaining({
          detail: expect.stringContaining("and the photos Kimmy added leave the album."),
        }),
      ),
    );
  });

  test("the Admin taps Let add photos on a Viewer and gets a toast", async () => {
    const viewerStatus = {
      ...status,
      members: [
        { key: "k0", name: "Me", admin: true, connected: true },
        { key: "k1", name: "Nils", admin: false, connected: false, identity: "i1", viewer: true },
      ],
    } as unknown as SyncStatus;
    syncActor.send(statusSeen.create({ status: viewerStatus }));
    people.open();
    const host = document.createElement("div");
    render(albumView("f1"), host);
    const button = buttonNamed(host, /^Let .+ add photos$/);
    expect(button && flat(button).trim()).toBe("Let Kimmy add photos");
    button?.click();
    await vi.waitFor(() => expect(gateway.makeMember).toHaveBeenCalledWith("f1", "k1"));
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith("Kimmy can add photos now"));
  });

  test("the Admin removes a Collaborator and gets a toast naming them", async () => {
    vi.mocked(gateway.removeMember).mockResolvedValue([null, { ok: true }] as any);
    vi.mocked(confirmAction).mockResolvedValueOnce(true);
    const host = document.createElement("div");
    syncActor.send(statusSeen.create({ status }));
    people.open();
    render(albumView("f1"), host);
    const remove = buttonNamed(memberRows(host)[1], /^Remove /);
    remove?.click();
    await vi.waitFor(() =>
      expect(toast).toHaveBeenCalledWith(expect.stringMatching(/^Kimmy is no longer in .+/)),
    );
  });

  test("both member buttons are disabled while Let add photos is in progress", async () => {
    vi.mocked(gateway.makeMember).mockReturnValue(new Promise(() => {}));
    const busyStatus = {
      ...status,
      members: [
        { key: "k0", name: "Me", admin: true, connected: true },
        { key: "k1", name: "Nils", admin: false, connected: false, identity: "i1", viewer: true },
        { key: "k2", name: "Ada", admin: false, connected: false, identity: "i2" },
      ],
    } as unknown as SyncStatus;
    syncActor.send(statusSeen.create({ status: busyStatus }));
    people.open();
    const host = document.createElement("div");
    render(albumView("f1"), host);
    const letButton = () => buttonNamed(host, /^Let .+ add photos$/);
    const removeButton = () => buttonNamed(host, /^Remove /);
    expect(letButton()?.disabled).toBe(false);
    expect(removeButton()?.disabled).toBe(false);
    letButton()?.click();
    await vi.waitFor(() => expect(gateway.makeMember).toHaveBeenCalled());
    render(albumView("f1"), host);
    expect(letButton()?.disabled).toBe(true);
    expect(removeButton()?.disabled).toBe(true);
  });

  test("non-Viewers have no Let add photos button", () => {
    syncActor.send(statusSeen.create({ status }));
    people.open();
    const host = document.createElement("div");
    render(albumView("f1"), host);
    expect(host.textContent).not.toContain("Let add photos");
  });
});

describe("album requests motion", () => {
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
    // The requests card is one row of 56px per request plus its heading.
    const height = (el: Element) =>
      el.matches('[data-motion-key="section:requests"]')
        ? 56 * (1 + el.querySelectorAll("li").length)
        : 56;
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const before = this.parentElement ? [...this.parentElement.children].indexOf(this) : 0;
      const top = this.parentElement
        ? [...this.parentElement.children].slice(0, before).reduce((n, e) => n + height(e), 0)
        : 0;
      return { left: 0, top, width: 300, height: height(this) } as any;
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
    vi.mocked(gateway.requests).mockResolvedValue([null, { requests: [] }] as never);
  });

  const ask = (requesterKey: string) => ({
    folderId: "f1",
    folderName: "Trip",
    requesterKey,
    requesterName: requesterKey,
    shareKey: "s",
    requestedAt: Date.now(),
  });
  const sections = ["invite", "members", "advanced"];
  const byKey = (host: HTMLElement, key: string) =>
    host.querySelector<HTMLElement>(`[data-motion-key="${key}"]`)!;
  const mine = (host: HTMLElement) =>
    calls.filter((c) => host.contains(c.el) || c.el.parentElement === document.body);
  const load = async (list: ReturnType<typeof ask>[]) => {
    vi.mocked(gateway.requests).mockResolvedValue([null, { requests: list }] as never);
    requests.refresh();
    await requestsActor.settled();
  };
  const mountWith = async (list: ReturnType<typeof ask>[]) => {
    await load([]);
    syncActor.send(statusSeen.create({ status }));
    people.open();
    const host = document.createElement("div");
    document.body.append(host);
    render(albumView("f1"), host);
    if (list.length > 0) {
      await load(list);
      await vi.waitFor(() => expect(host.textContent).toContain("wants to join"));
      await Promise.resolve();
    }
    calls = [];
    return host;
  };
  const slides = (host: HTMLElement, delay?: number) =>
    sections.map((s) => {
      const c = mine(host).find((x) => x.el === byKey(host, `section:${s}`));
      expect(c, s).toBeDefined();
      if (delay !== undefined) expect(c!.options.delay).toBe(delay);
      return c!;
    });

  test("a join request fades its card in and slides the sections below", async () => {
    const host = await mountWith([]);
    const invite = byKey(host, "section:invite");
    const members = byKey(host, "section:members");
    const rows = memberRows(host);
    await load([ask("nils")]);
    await vi.waitFor(() => expect(host.textContent).toContain("wants to join"));
    await Promise.resolve();
    expect(byKey(host, "section:invite")).toBe(invite);
    expect(byKey(host, "section:members")).toBe(members);
    memberRows(host).forEach((row, i) => expect(row).toBe(rows[i]));
    const card = mine(host).find((c) => c.el === byKey(host, "section:requests"))!;
    expect(card.keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    slides(host);
    rows.forEach((row) => expect(mine(host).some((c) => c.el === row)).toBe(false));
  });

  test("accepting the last request fades the card out and slides the sections up", async () => {
    const host = await mountWith([ask("nils")]);
    const card = byKey(host, "section:requests");
    vi.mocked(gateway.requests).mockResolvedValue([null, { requests: [] }] as never);
    [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Accept")!.click();
    await vi.waitFor(() => expect(host.textContent).not.toContain("wants to join"));
    await requestsActor.settled();
    expect(card.inert).toBe(true);
    const fade = calls.find((c) => c.el === card)!;
    expect(fade.keyframes).toEqual([{ opacity: 1 }, { opacity: 0 }]);
    slides(host, 150);
    memberRows(host).forEach((row) => expect(calls.some((c) => c.el === row)).toBe(false));
  });

  test("answering one of two requests fades only that row", async () => {
    const host = await mountWith([ask("nils"), ask("ola")]);
    const card = byKey(host, "section:requests");
    const nils = byKey(host, "request:f1/nils");
    const ola = byKey(host, "request:f1/ola");
    vi.mocked(gateway.requests).mockResolvedValue([null, { requests: [ask("ola")] }] as never);
    [...nils.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Decline")!.click();
    await vi.waitFor(() => expect(flat(host)).not.toContain("nils wants"));
    await requestsActor.settled();
    expect(byKey(host, "section:requests")).toBe(card);
    expect(byKey(host, "request:f1/ola")).toBe(ola);
    const fade = calls.find((c) => c.el === nils)!;
    expect(fade.keyframes).toEqual([{ opacity: 1 }, { opacity: 0 }]);
    slides(host, 0);
    expect(calls.some((c) => c.el === card)).toBe(false);
  });
});

describe("leave and delete copy", () => {
  test("a Member is told their photos go; a Viewer is not", () => {
    expect(leaveDetail("member", "Nils")).toBe(
      "It disappears from this phone, along with the photos you added to it, and you drop off the people list. To come back you need a new invite from Nils.",
    );
    expect(leaveDetail("reader", "the Admin")).toBe(
      "It disappears from this phone. To come back you need a new invite from the Admin.",
    );
  });

  const tail = "The album and its";
  test.each([
    [
      0,
      [],
      "Delete “Trip”?",
      `${tail} 0 photos are removed from this phone. This can't be undone.`,
    ],
    [1, [], "Delete “Trip”?", `${tail} 1 photo are removed from this phone. This can't be undone.`],
  ])("alone, %i photos", (photos, others, title, detail) => {
    expect(deleteSheet("Trip", photos, others)).toEqual({ title, detail });
  });

  const head = (photos: number) =>
    `${tail} ${photos === 1 ? "1 photo" : `${photos} photos`}, including the ones other people added, will be removed from every member's phone.`;
  const rest = " This can't be undone. Photos saved to a phone's camera roll are not touched.";
  const on = (name: string) => ({ name, connected: true });
  const off = (name: string) => ({ name, connected: false });
  test.each([
    [1, [on("Ann")], " Ann loses it now."],
    [1, [off("Ann")], " Ann loses it the next time their phone connects."],
    [
      5,
      [on("Ann"), off("Bo")],
      " Ann loses it now. Bo loses it the next time their phone connects.",
    ],
    [5, [off("Ann"), off("Bo")], " Ann and Bo lose it the next time their phones connect."],
    [5, [on("Ann"), on("Bo"), on("Cy")], " Ann, Bo and Cy lose it now."],
    [
      5,
      [on("Ann"), on("Bo"), on("Cy"), on("Di"), off("Ed"), off("Flo")],
      " Ann, Bo, Cy and Di lose it now. Ed and Flo lose it the next time their phones connect.",
    ],
  ])("with others, %i photos, %j", (photos, others, lose) => {
    expect(deleteSheet("Trip", photos, others)).toEqual({
      title: "Delete “Trip” for everyone?",
      detail: head(photos) + lose + rest,
    });
  });
});

describe("album menu items", () => {
  test.each([
    ["creator", false, ["Archive", "Delete album"]],
    ["member", false, ["Archive", "Leave album"]],
    ["reader", false, ["Archive", "Leave album"]],
    ["reader", true, ["Archive"]],
  ] as const)("%s (pending %s)", (role, pending, labels) => {
    expect(albumMenuItems(role, pending).map((i) => i.label)).toEqual(labels);
  });

  test.each([
    ["reader", false, true, ["Archive", "Delete from this phone"]],
    ["member", false, true, ["Archive", "Delete from this phone"]],
    ["reader", true, true, ["Archive"]],
  ] as const)("removed %s (pending %s, removed %s)", (role, pending, removed, labels) => {
    expect(albumMenuItems(role, pending, removed).map((i) => i.label)).toEqual(labels);
  });

  test("a removed person's dialog says the Admin sees it", () => {
    expect(removedDeleteSheet("Trip", "Anna")).toEqual({
      title: "Delete “Trip” from this phone?",
      detail:
        "You're no longer in this album. Its photos are deleted from this phone, and Anna sees that it no longer has them. To come back you need a new invite from Anna.",
      confirmLabel: "Delete",
    });
  });

  test("the album page shows the menu with the Admin's items", () => {
    syncActor.send(statusSeen.create({ status }));
    const host = document.createElement("div");
    render(albumView("f1"), host);
    expect(host.querySelector("[aria-label='More options']")).not.toBeNull();
    expect(
      [...host.querySelectorAll("wa-dropdown-item")].map((i) => i.textContent?.trim()),
    ).toEqual(["Archive", "Delete album"]);
  });
});

describe("album member roles", () => {
  const mixed = {
    ...status,
    members: [
      { key: "k0", name: "Me", admin: true, connected: true },
      { key: "k1", name: "Nils", admin: false, connected: false, identity: "i1" },
      { key: "k2", name: "Zed", admin: false, connected: false, identity: "i2", viewer: true },
    ],
  } as unknown as SyncStatus;

  test("each row says what that person can do", () => {
    syncActor.send(statusSeen.create({ status: mixed }));
    people.open();
    const host = document.createElement("div");
    render(albumView("f1"), host);
    const rows = [...host.querySelectorAll("li")];
    const row = (name: string) => rows.find((r) => r.textContent?.includes(name));
    expect(row("Me")?.textContent).toContain("Admin · adds people and photos");
    expect(row("Nils")?.textContent).toContain("Collaborator · adds photos");
    expect(row("Zed")?.textContent).toContain("Viewer · sees every photo, adds none");
    for (const r of rows) {
      const nameLine = r.querySelector("p")?.textContent ?? "";
      expect(nameLine).not.toMatch(/Admin|Collaborator|Viewer/);
    }
  });

  test("the role line wraps instead of being cut off", () => {
    syncActor.send(statusSeen.create({ status: mixed }));
    people.open();
    const host = document.createElement("div");
    render(albumView("f1"), host);
    const line = host.querySelector('[data-copy-id="album.collaborator_adds_photos"]');
    expect(line?.closest("p")?.classList.contains("truncate")).toBe(false);
  });

  test("the caption says what you can do", () => {
    const captionFor = (role: string) => {
      syncActor.send(
        statusSeen.create({
          status: { ...status, folder: { ...status.folder, role } } as unknown as SyncStatus,
        }),
      );
      const host = document.createElement("div");
      render(albumView("f1"), host);
      return host.querySelector('[data-copy-id^="album.you_"]')?.textContent;
    };
    expect(captionFor("creator")).toBe("You're the Admin: you add people and photos.");
    expect(captionFor("member")).toBe("You can add photos.");
    expect(captionFor("reader")).toBe("You can see every photo but not add any.");
  });

  test("a waiting joiner sees no role line and no caption", () => {
    syncActor.send(
      statusSeen.create({
        status: {
          ...mixed,
          folder: { ...status.folder, role: "reader", pending: true },
        } as unknown as SyncStatus,
      }),
    );
    people.open();
    const host = document.createElement("div");
    render(albumView("f1"), host);
    const own = [...host.querySelectorAll("li")].find((r) => r.textContent?.includes("Me"));
    expect(own?.textContent).not.toMatch(/Admin ·|Collaborator|Viewer ·/);
    expect(host.querySelector('[data-copy-id^="album.you_"]')).toBeNull();
    expect(host.textContent).toContain("Waiting for approval");
  });
});

describe("album ••• menu while the albums load", () => {
  const items = (host: HTMLElement) => [...host.querySelectorAll("wa-dropdown-item")];

  test("is disabled until the albums are listed, then enabled", async () => {
    let resolve: (v: unknown) => void = () => {};
    vi.mocked(gateway.folders).mockReturnValue(new Promise((r) => (resolve = r)) as never);
    syncActor.send(statusSeen.create({ status }));
    const host = document.createElement("div");
    render(albumView("f1"), host);
    folders.refresh();
    expect(items(host).length).toBeGreaterThan(0);
    expect(items(host).every((i) => i.hasAttribute("disabled"))).toBe(true);
    resolve([null, { folders: [], activeFolderId: null }]);
    await vi.waitFor(() => expect(folders.state()).toBe("showingAlbums"));
    expect(items(host).some((i) => i.hasAttribute("disabled"))).toBe(false);
  });
});

describe("removed from the album", () => {
  const removed = {
    ...status,
    folder: { ...status.folder, role: "reader", notice: { kind: "removed" } },
  } as unknown as SyncStatus;

  test("Invite & members shows the notice, no role chip and no member list", () => {
    syncActor.send(statusSeen.create({ status: removed }));
    people.open();
    const host = document.createElement("div");
    render(albumView("f1"), host);
    expect(host.querySelector("[role=status]")?.textContent?.trim()).toBe(
      "You're no longer in Trip.",
    );
    expect(host.textContent).not.toContain("Viewer");
    expect(host.querySelector('[data-copy-id^="album.you_"]')).toBeNull();
    expect(memberRows(host)).toHaveLength(0);
  });

  test("the Remove confirm says the person sees they are out", () => {
    expect(removeDetail("Nils", false)).toContain("sees they're no longer in the album");
    expect(removeDetail("Nils", true)).toContain("sees they're no longer in the album");
  });
});

describe("album holding", () => {
  const photo = (id: string, folderId: string, kimHas: boolean, here = true) => ({
    id,
    folderId,
    holders: {
      here,
      others: kimHas ? [{ key: "k1", name: "Kim" }] : [],
      unsure: [{ key: "k2", name: "Zed" }],
      waiting: [],
      former: [],
      left: [],
    },
  });
  const open = async (photos: unknown[]) => {
    vi.mocked(gateway.list).mockResolvedValue([null, { photos }] as never);
    syncActor.send(statusSeen.create({ status }));
    people.open();
    await gallery.load();
    const host = document.createElement("div");
    render(albumView("f1"), host);
    return host;
  };

  test("each member shows how many photos they hold, once", async () => {
    const host = await open([
      photo("a", "f1", true),
      photo("b", "f1", true, false),
      photo("c", "f1", false),
      photo("x", "f2", true),
    ]);
    const rows = memberRows(host);
    expect(rows).toHaveLength(3);
    expect(rows[0]?.textContent).toContain("Has 2 of 3 photos");
    expect(rows[1]?.textContent).toContain("Has 2 of 3 photos");
    expect(rows[2]?.textContent).toContain("Hasn't said yet which photos they have");
    expect(host.textContent).toContain("first opened there");
  });

  test("the Members card shows one line, then the people, then what the lines mean", async () => {
    const host = await open([photo("a", "f1", true)]);
    const section = host.querySelector('[data-motion-key="section:members"]')!;
    const ul = section.querySelector("ul")!;
    const caption = section.querySelector("p")!;
    expect(caption.textContent?.trim()).toBe("Everyone in the album sees this list.");
    expect(caption.compareDocumentPosition(ul) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const after = ul.nextElementSibling!;
    expect(after.tagName).toBe("P");
    expect(after.textContent).toContain("Connected means they have Justus open");
    expect(after.textContent).toContain("first opened there");
    expect(section.textContent).not.toContain("Viewers see every photo");
  });

  test("an album with no photos says nothing about holdings", async () => {
    const host = await open([]);
    expect(host.textContent).not.toContain("Has ");
    expect(host.textContent).not.toContain("first opened there");
  });

  test("a holders push updates the same row", async () => {
    const host = await open([photo("a", "f1", true), photo("b", "f1", false)]);
    const kim = memberRows(host)[1];
    expect(kim?.textContent).toContain("Has 1 of 2 photos");
    vi.mocked(gateway.list).mockResolvedValue([
      null,
      { photos: [photo("a", "f1", true), photo("b", "f1", true)] },
    ] as never);
    await gallery.load();
    await vi.waitFor(() => expect(kim?.textContent).toContain("Has 2 of 2 photos"));
    expect(memberRows(host)[1]).toBe(kim);
  });
});
