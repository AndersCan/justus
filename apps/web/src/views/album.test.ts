// @vitest-environment happy-dom
import { focusOnArrival } from "./arrival-focus";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { html, render } from "lit-html";
import type { SyncStatus } from "@justus/core";
import { copy } from "../copy/copy";
import { friends, friendsActor } from "../machines/friends-machine";
import { people, peopleActor } from "../machines/people-machine";
import { statusSeen, syncActor } from "../machines/sync-machine";
import { requests, requestsActor } from "../machines/requests-machine";
import { folders, foldersActor } from "../machines/folders-machine";
import { gateway } from "../gateway";
import { gallery } from "../machines/gallery-machine";
import {
  acceptAllToast,
  albumMenuItems,
  removedDeleteSheet,
  albumView,
  declinedToast,
  revealMember,
  deleteSheet,
  leaveDetail,
  requestIdentity,
  removeDetail,
} from "./album";
import { open } from "../machines/router-machine";
import { memberColor } from "../utils/palette";
import { inviteLink, inviteLinkActor, inviteLinkViewOf } from "../machines/sharing/invite-link";
import { toast } from "./toast";
import { confirmAction } from "./confirm";

/** A press and release on the dim area: the dialog itself is the target. */
function tapOutside(dialog: Element) {
  dialog.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  dialog.dispatchEvent(new Event("click", { bubbles: true }));
}

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
    saveInviteLink: vi.fn().mockResolvedValue([null, { ok: true }]),
    makeMember: vi.fn().mockResolvedValue([null, { ok: true }]),
    makeViewer: vi.fn().mockResolvedValue([null, { ok: true }]),
    takeBackOffer: vi.fn().mockResolvedValue([null, { ok: true }]),
    respond: vi.fn().mockResolvedValue([null, { ok: true }]),
    logs: { view: vi.fn(), clear: vi.fn() },
    media: { pickMany: vi.fn() },
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
    { key: "k0", name: "Me", admin: true, connected: true, color: 0 },
    { key: "k1", name: "Kim", admin: false, connected: true, identity: "i1", color: 1 },
    { key: "k2", name: "Zed", admin: false, connected: false, identity: "i2", color: 2 },
  ],
  folder: { id: "f1", name: "Trip", role: "creator", shareKey: "s", driveKey: "d", members: 3 },
} as unknown as SyncStatus;

const memberRows = (host: HTMLElement) => [
  ...host.querySelectorAll<HTMLLIElement>("ul.divide-y > li"),
];

const controls = (row: Element) => [...row.querySelectorAll("button")].map((b) => flat(b).trim());
const buttonNamed = (host: ParentNode, re: RegExp) =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => re.test(flat(b).trim()));

describe("Stop adding photos", () => {
  const viewerStatus = {
    ...status,
    members: [
      { key: "k0", name: "Me", admin: true, connected: true, color: 0 },
      { key: "k1", name: "Nils", admin: false, connected: false, identity: "i1", color: 1 },
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

  test("a Collaborator row shows Stop Nils adding photos before Remove Nils", () => {
    const row = memberRows(open()).find((r) => r.textContent?.includes("Nils"));
    expect(controls(row!).slice(-2)).toEqual(["Stop Nils adding photos", "Remove Nils"]);
  });

  test("confirm copy names the person", async () => {
    vi.mocked(confirmAction).mockResolvedValueOnce(false);
    buttonNamed(open(), /^Stop Nils adding photos$/)?.click();
    await vi.waitFor(() =>
      expect(confirmAction).toHaveBeenCalledWith({
        title: "Stop Nils adding photos?",
        detail:
          "Nils keeps seeing every photo but can't add more. The photos Nils already added stay in the album.",
        confirmLabel: "Stop adding photos",
        cancelLabel: "Keep adding photos",
      }),
    );
  });

  test("confirming calls makeViewer; cancelling does not", async () => {
    vi.mocked(confirmAction).mockResolvedValueOnce(false);
    const host = open();
    const button = () => buttonNamed(host, /^Stop Nils adding photos$/);
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
            { key: "k0", name: "Me", admin: true, connected: true, color: 0 },
            { key: "k3", name: "Ada", admin: true, connected: true, identity: "i3" },
            { key: "k1", name: "Nils", admin: false, connected: false, identity: "i1", color: 1 },
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
    const role = buttonNamed(host, /^Stop Nils adding photos$/)!;
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
  test("each row's avatar is the colour of that person's header dot", () => {
    syncActor.send(statusSeen.create({ status }));
    people.open();
    const host = document.createElement("div");
    render(albumView("f1"), host);
    const fills = memberRows(host).map((r) =>
      r.querySelector("span[style]")?.getAttribute("style"),
    );
    expect(fills).toEqual([0, 1, 2].map((c) => `background:${memberColor(c)}`));
  });

  test("a member with a colour has a filled avatar, not the outline", () => {
    syncActor.send(statusSeen.create({ status }));
    people.open();
    const host = document.createElement("div");
    render(albumView("f1"), host);
    const badge = memberRows(host)[1].querySelector("span[aria-hidden]")!;
    expect(badge.className.split(" ")).toContain("ui-avatar");
    expect(badge.className).not.toContain("ui-avatar-outline");
  });

  test("a member without a colour has an outlined avatar and no style", () => {
    const members = status.members.map((m, i) => (i === 1 ? { ...m, color: undefined } : m));
    syncActor.send(statusSeen.create({ status: { ...status, members } }));
    people.open();
    const host = document.createElement("div");
    render(albumView("f1"), host);
    const badge = memberRows(host)[1].querySelector("span[aria-hidden]")!;
    expect(badge.getAttribute("style")).toBeNull();
    expect(badge.className).toContain("ui-avatar-outline");
  });

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
            { key: "k0", name: "Me", admin: true, connected: true, color: 0 },
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
    declinedEarlier: undefined as boolean | undefined,
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

  afterEach(async () => {
    if (requests.state() === "confirmingAcceptAll") requests.cancelAcceptAll();
    await requestsActor.settled();
    for (const h of requestsActor.snapshot().context.heldDeclines) {
      vi.mocked(gateway.respond).mockResolvedValueOnce([null, { ok: true }] as never);
      await requests.sendDecline(h.request.folderId, h.request.requesterKey);
    }
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

  test("rows show their three words and the section says what it is for", async () => {
    const host = await show([
      { ...ask("a", true, "maple river stone"), requesterName: "Ben" },
      { ...ask("b", true, "lamp ocean tiger"), requesterName: "Ben" },
    ]);
    const rows = [...host.querySelectorAll<HTMLElement>('li[data-motion-key^="request:"]')];
    expect(flat(rows[0]!)).toContain("Three words maple river stone");
    expect(flat(rows[1]!)).toContain("Three words lamp ocean tiger");
    expect(flat(rows[0]!)).toContain("Same words on Ben's phone? Then it's Ben. If not, decline.");
    expect(flat(rows[1]!)).toContain("Same words on Ben's phone? Then it's Ben. If not, decline.");
    expect(rows[0]!.querySelector(".text-lg")?.textContent?.trim()).toBe("maple river stone");
    expect(rows[1]!.querySelector(".text-lg")?.textContent?.trim()).toBe("lamp ocean tiger");
    expect(host.textContent).not.toContain("Not sure who it is?");
    expect(flat(host).toLowerCase()).not.toContain("check code");
  });

  test("two link asks say how many asked, in the hint paragraph above Accept all", async () => {
    const host = await show([ask("nils", true, "a b c"), ask("ola", true, "d e f")]);
    const hint =
      [...host.querySelectorAll("p.text-muted")]
        .map((x) => x.textContent?.trim() ?? "")
        .find((t) => t.includes("people asked")) ?? "";
    expect(hint).toBe("2 people asked with your invite link. Decline anyone you don't know.");
    const one = await show([ask("nils", true)]);
    expect(one.textContent).not.toContain("people asked with your invite link");
    const mixed = await show([ask("nils", true), ask("ola", false)]);
    expect(mixed.textContent).not.toContain("people asked with your invite link");
  });

  test("the identity line alone has name, three words and no wants to join", () => {
    const host = document.createElement("div");
    const row = {
      ...ask("a", true, "maple river stone"),
      name: "Dad",
      friend: true,
      requesterName: "Ben",
    };
    render(requestIdentity(row, null), host);
    const text = flat(host);
    expect(text).toContain("Dad");
    expect(text).toContain("· Friend");
    expect(text).toContain("Ben");
    expect(text).toContain("Three words maple river stone");
    expect(text).not.toContain("· Three words");
    expect(text).not.toContain("Then it's");
    expect(text).not.toContain("wants to join");
    render(requestIdentity(row, html`wants to join Trip`), host);
    expect(flat(host)).toContain("Dad wants to join Trip");
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
    const rowB = rows.find((r) => flat(r).includes("Three words lamp ocean tiger"))!;
    const rowA = rows.find((r) => flat(r).includes("Three words maple river stone"))!;
    expect(rowB.textContent).toContain("Not your friend Dad");
    expect(rowA.textContent).not.toContain("Not your friend");
    expect(rowB.textContent).toContain("typed a friend's name.");
    expect(rowB.textContent).not.toContain("Then it's");
    expect(rowA.textContent).toContain("Then it's Dad");
    expect(host.textContent).not.toContain("Not sure who it is?");
    expect(button(host, "Accept all 1, can only look")).toBeUndefined();
    expect(
      [...host.querySelectorAll("button")].some((b) => name(b)?.startsWith("Accept all")),
    ).toBe(false);
    expect(
      [...host.querySelectorAll("button")].filter((b) => name(b) === "Accept, can only look"),
    ).toHaveLength(2);
  });

  test("without codes there is no three words text", async () => {
    const host = await show([ask("nils", true)]);
    expect(host.textContent).not.toContain("Three words");
    expect(host.textContent).not.toContain("Same words");
    expect(host.textContent).not.toContain("Not sure who it is?");
  });

  test("a link card has one primary button and Decline looks like the second Accept", async () => {
    const host = await show([ask("nils", true, "a b c"), ask("ola", true, "d e f")]);
    const rows = [...host.querySelectorAll<HTMLElement>('li[data-motion-key^="request:"]')];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.querySelectorAll(".ui-btn-primary")).toHaveLength(1);
      const by = (text: string) =>
        [...row.querySelectorAll("button")].find((b) => name(b)?.startsWith(text))!;
      expect(by("Decline").className).toBe(by("Accept, can add photos").className);
      expect(by("Decline").className).toContain("w-full");
    }
  });

  test("a request not from a link has Decline and Accept sharing the row", async () => {
    const host = await show([ask("nils", false)]);
    const row = host.querySelector<HTMLElement>('li[data-motion-key^="request:"]')!;
    const buttons = [...row.querySelectorAll("button")];
    expect(buttons.map(name)).toEqual(["Decline", "Accept"]);
    for (const b of buttons) expect(b.className).toContain("flex-1");
  });

  test("an invite request offers Accept, can only look, Accept, can add photos and Decline, each with its meaning; Viewer sends reader", async () => {
    const host = await show([ask("nils", true)]);
    expect(
      [...host.querySelectorAll<HTMLElement>('li[data-motion-key^="request:"] button')].map(name),
    ).toEqual(["Accept, can only look", "Accept, can add photos", "Decline"]);
    expect(host.textContent).toContain("Sees every photo, can't add any");
    expect(host.textContent).toContain("Sees every photo and can add their own");
    expect(host.textContent).not.toContain("A Viewer sees every photo. A Collaborator");
    expect(button(host, "Accept")).toBeUndefined();
    expect(button(host, "Accept, can only look")!.className).toContain("ui-btn-primary");
    for (const n of ["Accept, can add photos", "Decline"]) {
      expect(button(host, n)!.className).toContain("ui-btn-ghost");
      expect(button(host, n)!.className).not.toContain("ui-btn-primary");
    }
    expect(host.querySelectorAll('li[data-motion-key^="request:"] .ui-btn-primary')).toHaveLength(
      1,
    );
    button(host, "Accept, can only look")!.click();
    await vi.waitFor(() =>
      expect(gateway.respond).toHaveBeenCalledWith("f1", "nils", true, "reader"),
    );
  });

  test("Accept, can add photos sends the member role", async () => {
    const host = await show([ask("nils", true)]);
    button(host, "Accept, can add photos")!.click();
    await vi.waitFor(() =>
      expect(gateway.respond).toHaveBeenCalledWith("f1", "nils", true, "member"),
    );
  });

  const declineToast = () => {
    const call = vi.mocked(toast).mock.calls.find(([m]) => m.startsWith("Declined"))!;
    return call[1] as { action: { label: string; run: () => void }; onClose: () => void };
  };

  test("Decline takes the card away, names who, and sends nothing until the toast closes", async () => {
    vi.mocked(toast).mockClear();
    vi.mocked(gateway.respond).mockClear();
    const host = await show([ask("nils", true), ask("ola", true)]);
    button(host, "Decline")!.click();
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith("Declined nils", expect.anything()));
    expect(declineToast().action.label).toBe("Undo");
    expect(flat(host)).not.toContain("nils wants");
    expect(host.textContent).toContain("ola");
    expect(gateway.respond).not.toHaveBeenCalled();
    declineToast().onClose();
    await vi.waitFor(() => expect(gateway.respond).toHaveBeenCalledWith("f1", "nils", false));
    await requestsActor.settled();
    expect(flat(host)).not.toContain("nils wants");
  });

  test("Decline, Undo, then Accept lets the person in and nothing was declined", async () => {
    vi.mocked(toast).mockClear();
    vi.mocked(gateway.respond).mockClear();
    const host = await show([ask("nils", true), ask("ola", true)]);
    button(host, "Decline")!.click();
    await vi.waitFor(() => expect(toast).toHaveBeenCalled());
    declineToast().action.run();
    await vi.waitFor(() => expect(flat(host)).toContain("nils wants"));
    declineToast().onClose();
    await requestsActor.settled();
    expect(gateway.respond).not.toHaveBeenCalled();
    button(host, "Accept, can only look")!.click();
    await vi.waitFor(() =>
      expect(gateway.respond).toHaveBeenCalledWith("f1", "nils", true, "reader"),
    );
    expect(gateway.respond).toHaveBeenCalledTimes(1);
    await requestsActor.settled();
  });

  test("a Decline that cannot be sent brings the card back", async () => {
    vi.mocked(toast).mockClear();
    const host = await show([ask("nils", true)]);
    vi.mocked(gateway.respond).mockResolvedValueOnce([new Error("offline"), null] as never);
    button(host, "Decline")!.click();
    await vi.waitFor(() => expect(toast).toHaveBeenCalled());
    declineToast().onClose();
    await vi.waitFor(() => expect(flat(host)).toContain("nils wants"));
    expect(toast).toHaveBeenCalledWith("Couldn't send your No to nils. The request is back.");
    await requestsActor.settled();
  });

  test("a Decline without a name that cannot be sent says 'them' in lower case", async () => {
    vi.mocked(toast).mockClear();
    const host = await show([{ ...ask("k9", true), requesterName: "" }]);
    vi.mocked(gateway.respond).mockResolvedValueOnce([new Error("offline"), null] as never);
    button(host, "Decline")!.click();
    await vi.waitFor(() => expect(toast).toHaveBeenCalled());
    declineToast().onClose();
    await vi.waitFor(() =>
      expect(toast).toHaveBeenCalledWith("Couldn't send your No to them. The request is back."),
    );
    await requestsActor.settled();
  });

  test("a Decline answered with 'request cancelled' keeps the card gone, with no failure toast", async () => {
    vi.mocked(toast).mockClear();
    const host = await show([ask("nils", true)]);
    vi.mocked(gateway.respond).mockResolvedValueOnce([
      { code: "justus.photos/request-cancelled", message: "cancelled" },
      null,
    ] as never);
    button(host, "Decline")!.click();
    await vi.waitFor(() => expect(toast).toHaveBeenCalled());
    declineToast().onClose();
    await requestsActor.settled();
    await vi.waitFor(() => expect(requestsActor.snapshot().context.heldDeclines).toEqual([]));
    expect(flat(host)).not.toContain("nils wants");
    expect(toast).not.toHaveBeenCalledWith(expect.stringContaining("Couldn't send your No"));
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
      .find((b) => name(b) === "Accept, can only look")!
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
    await vi.waitFor(() => expect(gateway.respond).toHaveBeenCalledTimes(2));
    expect(toast).not.toHaveBeenCalled();
    expect(gateway.respond).toHaveBeenLastCalledWith("f1", "nils", true, "reader");
    await requestsActor.settled();
    await vi.waitFor(() => expect(card("nils")).toBeUndefined());
  });

  test("a phone declined earlier says so and is left out of Accept all", async () => {
    const host = await show([
      ask("nils", true),
      { ...ask("bo", true), declinedEarlier: true },
      ask("ola", true),
    ]);
    const rows = [...host.querySelectorAll<HTMLElement>('li[data-motion-key^="request:"]')];
    const flagged = rows.filter((r) => r.textContent?.includes("Declined earlier"));
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.textContent).toContain("bo");
    expect(button(host, "Accept all 2, can only look")).toBeDefined();
  });

  test("two invite requests show Accept all 2, can only look below the list", async () => {
    const host = await show([ask("nils", true), ask("ola", true)]);
    const all = button(host, "Accept all 2, can only look")!;
    expect(all).toBeDefined();
    expect(
      host.querySelector("ul")!.compareDocumentPosition(all) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(all.className).toContain("text-accent");
    expect(all.className).not.toContain("ui-btn");
    expect(host.textContent).not.toContain("They can see the photos");
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
    button(host, "Accept all 2, can only look")!.click();
    await vi.waitFor(() => expect(button(host, "Accept 2, can only look")).toBeDefined());
    button(host, "Accept 2, can only look")!.click();
    await vi.waitFor(() => expect(resolvers).toHaveLength(1));
    await vi.waitFor(() => {
      expect(button(host, "Accept all 2, can only look")?.disabled).toBe(true);
      const rowButtons = [
        ...host.querySelectorAll<HTMLButtonElement>('li[data-motion-key^="request:"] button'),
      ];
      expect(rowButtons.every((b) => b.disabled)).toBe(true);
    });
    resolvers[0]([null, { ok: true }]);
    await vi.waitFor(() => expect(resolvers).toHaveLength(2));
    expect(toast).not.toHaveBeenCalled();
    resolvers[1]([null, { ok: true }]);
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith("2 people are in and can only look"));
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
    button(host, "Accept all 2, can only look")!.click();
    await vi.waitFor(() => expect(button(host, "Accept 2, can only look")).toBeDefined());
    button(host, "Accept 2, can only look")!.click();
    await vi.waitFor(() => expect(button(host, "Retry")).toBeDefined());
    expect(host.querySelector("[role=alert]")?.textContent).toContain(
      "Couldn't connect. Check your internet and try again.",
    );
    expect(toast).not.toHaveBeenCalled();
    button(host, "Retry")!.click();
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith("2 people are in and can only look"));
    expect(toast).toHaveBeenCalledTimes(1);
    await requestsActor.settled();
  });

  test("Accept all opens a sheet naming everyone and answers nobody until Accept", async () => {
    vi.mocked(gateway.respond).mockClear();
    const host = await show([
      ask("nils", true, "maple river stone"),
      ask("ola", true, "lamp ocean tiger"),
    ]);
    button(host, "Accept all 2, can only look")!.click();
    await vi.waitFor(() =>
      expect(host.querySelector('dialog[aria-label^="Accept these"]')).not.toBeNull(),
    );
    const dialog = host.querySelector('dialog[aria-label^="Accept these"]')!;
    expect(dialog.getAttribute("aria-label")).toBe("Accept these 2 people? They can only look.");
    expect(flat(dialog)).toContain("nils");
    expect(flat(dialog)).toContain("ola");
    expect(flat(dialog)).toContain("Asked");
    expect(flat(dialog)).toContain("Three words maple river stone");
    expect(flat(dialog)).toContain("Three words lamp ocean tiger");
    expect(flat(dialog)).not.toContain("Then it's");
    expect([...dialog.querySelectorAll(".text-lg")].map((x) => x.textContent?.trim())).toEqual([
      "maple river stone",
      "lamp ocean tiger",
    ]);
    expect(flat(dialog)).toContain("every photo in “Trip”");
    expect(gateway.respond).not.toHaveBeenCalled();
    await requestsActor.settled();
  });

  const sheetOf = (host: HTMLElement) => host.querySelector('dialog[aria-label^="Accept these"]');
  const openSheet = async (host: HTMLElement, n: number) => {
    button(host, `Accept all ${n}, can only look`)!.click();
    await vi.waitFor(() => expect(sheetOf(host)).not.toBeNull());
  };

  test("a sheet with three people says three and lists them", async () => {
    const host = await show([ask("nils", true), ask("ola", true), ask("kim", true)]);
    await vi.waitFor(() => expect(button(host, "Accept all 3, can only look")).toBeDefined());
    await openSheet(host, 3);
    expect(sheetOf(host)!.getAttribute("aria-label")).toBe(
      "Accept these 3 people? They can only look.",
    );
    expect(sheetOf(host)!.querySelectorAll("li")).toHaveLength(3);
    expect(buttonNamed(sheetOf(host)!, /^Accept 3, can only look$/)).toBeDefined();
    await requestsActor.settled();
  });

  test("a tap on a name inside the sheet does not close it", async () => {
    const host = await show([ask("nils", true), ask("ola", true)]);
    await openSheet(host, 2);
    (sheetOf(host)!.querySelector("li") as HTMLElement).click();
    await requestsActor.settled();
    expect(sheetOf(host)).not.toBeNull();
    expect(requests.state()).toBe("confirmingAcceptAll");
  });

  test("focus lands on Cancel when the sheet opens and stays on Accept after a re-render", async () => {
    document.body.replaceChildren();
    friends.close();
    await new Promise((r) => setTimeout(r, 50));
    const host = await show([ask("nils", true), ask("ola", true)]);
    document.body.append(host);
    await openSheet(host, 2);
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(host.querySelector("[data-accept-all-cancel]")),
    );
    const accept = buttonNamed(sheetOf(host)!, /^Accept 2, can only look$/)!;
    accept.focus();
    syncActor.send(statusSeen.create({ status }));
    await new Promise((r) => setTimeout(r, 20));
    expect(flat(document.activeElement!).trim()).toBe("Accept 2, can only look");
    await requestsActor.settled();
  });

  test("Accept all is not stuck when the sheet is open in another album", async () => {
    const host = await show([ask("nils", true), ask("ola", true)]);
    await openSheet(host, 2);
    const other = document.createElement("div");
    const f2 = {
      ...status,
      folder: { ...status.folder, id: "f2", name: "Other" },
    } as unknown as SyncStatus;
    syncActor.send(statusSeen.create({ status: f2 }));
    render(albumView("f2"), other);
    await vi.waitFor(() => expect(other.textContent).toBeDefined());
    expect(sheetOf(other)).toBeNull();
  });

  test("leaving the page closes the sheet, lets nobody in and reloads the list", async () => {
    vi.mocked(gateway.respond).mockClear();
    const host = await show([ask("nils", true), ask("ola", true)]);
    await openSheet(host, 2);
    open("/help");
    await vi.waitFor(() => expect(requests.state()).not.toBe("confirmingAcceptAll"));
    await requestsActor.settled();
    expect(gateway.respond).not.toHaveBeenCalled();
    expect(sheetOf(host)).toBeNull();
    open("/");
  });

  test.each([
    [
      "Cancel",
      (host: HTMLElement) =>
        (host.querySelector("[data-accept-all-cancel]") as HTMLElement).click(),
    ],
    [
      "Escape",
      (host: HTMLElement) =>
        host
          .querySelector('dialog[aria-label^="Accept these"]')!
          .dispatchEvent(new Event("cancel", { cancelable: true })),
    ],
    [
      "a tap outside",
      (host: HTMLElement) => tapOutside(host.querySelector('dialog[aria-label^="Accept these"]')!),
    ],
  ])("%s closes the Accept all sheet, lets nobody in and keeps both cards", async (_n, close) => {
    vi.mocked(gateway.respond).mockClear();
    const host = await show([ask("nils", true), ask("ola", true)]);
    button(host, "Accept all 2, can only look")!.click();
    await vi.waitFor(() =>
      expect(host.querySelector('dialog[aria-label^="Accept these"]')).not.toBeNull(),
    );
    close(host);
    await vi.waitFor(() =>
      expect(host.querySelector('dialog[aria-label^="Accept these"]')).toBeNull(),
    );
    await requestsActor.settled();
    expect(gateway.respond).not.toHaveBeenCalled();
    expect(host.querySelectorAll('li[data-motion-key^="request:"]')).toHaveLength(2);
  });

  test("Decline lowers the count and the button goes at one", async () => {
    const host = await show([ask("nils", true), ask("ola", true), ask("kim", true)]);
    vi.mocked(gateway.respond).mockResolvedValue([null, { ok: true }] as never);
    const decline = (k: string) =>
      [...host.querySelectorAll("li")]
        .find((li) => flat(li).includes(`${k} wants`))!
        .querySelectorAll("button");
    [...decline("nils")].find((b) => name(b) === "Decline")!.click();
    await vi.waitFor(() => expect(button(host, "Accept all 2, can only look")).toBeDefined());
    [...decline("ola")].find((b) => name(b) === "Decline")!.click();
    await vi.waitFor(() => expect(button(host, "Accept all 2, can only look")).toBeUndefined());
    expect(
      [...host.querySelectorAll("button")].some((b) => name(b)?.startsWith("Accept all")),
    ).toBe(false);
    await requestsActor.settled();
    vi.mocked(gateway.respond).mockResolvedValue([null, { ok: true }] as never);
  });

  test("acceptAllToast: singular and plural", () => {
    expect(acceptAllToast(1)).toBe("1 person is in and can only look");
    expect(acceptAllToast(13)).toBe("13 people are in and can only look");
  });

  test("declinedToast names who was declined", () => {
    expect(declinedToast("Nils")).toBe("Declined Nils");
    expect(declinedToast("")).toBe("Declined that request");
    expect(declinedToast(copy("requests.they"))).toBe("Declined that request");
  });

  test("revealMember scrolls the accepted row to the middle and focuses it, waiting for a late row", async () => {
    const row = document.createElement("li");
    row.dataset.memberKey = "k9";
    row.tabIndex = -1;
    const scroll = vi.fn();
    row.scrollIntoView = scroll;
    revealMember("k9", 5);
    expect(scroll).not.toHaveBeenCalled();
    document.body.append(row);
    await vi.waitFor(() => expect(scroll).toHaveBeenCalledWith({ block: "center" }));
    expect(document.activeElement).toBe(row);
    row.remove();
  });

  test("a plain request keeps a single Accept that sends the member role", async () => {
    const host = await show([ask("ola", false)]);
    expect(host.textContent).not.toContain("Sees every photo");
    expect(button(host, "Accept, can only look")).toBeUndefined();
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
        { key: "k0", name: "Me", admin: true, connected: true, color: 0 },
        { key: "k1", name: "Nils", admin: false, connected: true, identity: "i1", viewer: true },
      ],
    } as unknown as SyncStatus;
    syncActor.send(statusSeen.create({ status: viewerStatus }));
    people.open();
    const host = document.createElement("div");
    render(albumView("f1"), host);
    const row = memberRows(host)[1];
    expect(row.textContent).toContain("Can only look");
    expect(row.textContent).toContain("connected");
    expect(row.querySelector("span.h-1\\.5")).not.toBeNull();
    expect(controls(row).slice(-2)).toEqual(["Let Kimmy add photos", "Remove Kimmy"]);
  });

  test("Remove on a Viewer asks with the Viewer text", async () => {
    const viewerStatus = {
      ...status,
      members: [
        { key: "k0", name: "Me", admin: true, connected: true, color: 0 },
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
        { key: "k0", name: "Me", admin: true, connected: true, color: 0 },
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
      expect(toast).toHaveBeenCalledWith(
        expect.stringMatching(/^Kimmy is no longer in .+\. Links you sent stopped working\.$/),
        { action: { label: "Copy new link", run: expect.any(Function) } },
      ),
    );
  });

  test("Copy new link in the removal toast saves a time and copies a link", async () => {
    vi.mocked(gateway.removeMember).mockResolvedValue([null, { ok: true }] as any);
    vi.mocked(gateway.saveInviteLink).mockClear();
    vi.mocked(toast).mockClear();
    vi.mocked(confirmAction).mockResolvedValueOnce(true);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const withInvite = {
      ...status,
      folder: { ...status.folder, invite: { code: "c1", owner: "o" } },
    } as unknown as SyncStatus;
    const host = document.createElement("div");
    syncActor.send(statusSeen.create({ status: withInvite }));
    people.open();
    render(albumView("f1"), host);
    inviteLink.createLink("f1", "c1");
    await inviteLinkActor.settled();
    expect(inviteLinkViewOf(inviteLinkActor.snapshot()).state).toBe("linkMade");
    buttonNamed(memberRows(host)[1], /^Remove /)?.click();
    await vi.waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    expect(inviteLinkViewOf(inviteLinkActor.snapshot())).toMatchObject({
      state: "noLinkYet",
      replacedFolderId: "f1",
      removedName: "Kimmy",
    });
    const options = vi.mocked(toast).mock.calls[0][1] as { action: { run: () => void } };
    vi.mocked(toast).mockClear();
    // The refresh after the removal brings the album's new code.
    syncActor.send(
      statusSeen.create({
        status: {
          ...withInvite,
          folder: { ...withInvite.folder, invite: { code: "c2", owner: "o" } },
        },
      } as never),
    );
    options.action.run();
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith("Invite link copied"));
    expect(gateway.saveInviteLink).toHaveBeenCalledWith("f1", expect.any(Number));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("justus://join"));
  });

  test("Copy new link on another album's page says it could not copy", async () => {
    vi.mocked(gateway.removeMember).mockResolvedValue([null, { ok: true }] as any);
    vi.mocked(gateway.saveInviteLink).mockClear();
    vi.mocked(toast).mockClear();
    vi.mocked(confirmAction).mockResolvedValueOnce(true);
    const host = document.createElement("div");
    syncActor.send(statusSeen.create({ status }));
    people.open();
    render(albumView("f1"), host);
    buttonNamed(memberRows(host)[1], /^Remove /)?.click();
    await vi.waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    const options = vi.mocked(toast).mock.calls[0][1] as { action: { run: () => void } };
    vi.mocked(toast).mockClear();
    syncActor.send(
      statusSeen.create({
        status: { ...status, folder: { ...status.folder, id: "f2" } },
      } as never),
    );
    options.action.run();
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith("Couldn't copy the invite link"));
    expect(gateway.saveInviteLink).not.toHaveBeenCalled();
  });

  test("a failed removal sends no toast and leaves the invite link alone", async () => {
    vi.mocked(gateway.removeMember).mockResolvedValue([new Error("no"), null] as any);
    vi.mocked(toast).mockClear();
    vi.mocked(confirmAction).mockResolvedValueOnce(true);
    const host = document.createElement("div");
    syncActor.send(statusSeen.create({ status }));
    people.open();
    render(albumView("f1"), host);
    buttonNamed(memberRows(host)[1], /^Remove /)?.click();
    await vi.waitFor(() => expect(gateway.removeMember).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(toast).not.toHaveBeenCalledWith(
      expect.stringContaining("Links you sent stopped working"),
      expect.anything(),
    );
    expect(inviteLinkViewOf(inviteLinkActor.snapshot()).replacedFolderId).toBe("");
  });

  test("both member buttons are disabled while Let add photos is in progress", async () => {
    vi.mocked(gateway.makeMember).mockReturnValue(new Promise(() => {}));
    const busyStatus = {
      ...status,
      members: [
        { key: "k0", name: "Me", admin: true, connected: true, color: 0 },
        { key: "k1", name: "Nils", admin: false, connected: false, identity: "i1", viewer: true },
        { key: "k2", name: "Ada", admin: false, connected: false, identity: "i2", color: 2 },
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
    // The requests card is one row of 56px per request plus its heading. A
    // `contents` wrapper has no box of its own: it is as tall as its children.
    const height = (el: Element): number =>
      el.classList.contains("contents")
        ? [...el.children].reduce((n, e) => n + height(e), 0)
        : el.matches('[data-motion-key="section:requests"]')
          ? 56 * (1 + el.querySelectorAll("li").length)
          : 56;
    Element.prototype.getBoundingClientRect = function (this: Element) {
      let box: Element = this;
      while (box.parentElement?.classList.contains("contents")) box = box.parentElement;
      const parent = box.parentElement;
      const before = parent ? [...parent.children].indexOf(box) : 0;
      const top = parent
        ? [...parent.children].slice(0, before).reduce((n, e) => n + height(e), 0)
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
      { key: "k0", name: "Me", admin: true, connected: true, color: 0 },
      { key: "k1", name: "Nils", admin: false, connected: false, identity: "i1", color: 1 },
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
    expect(row("Me")?.textContent).toContain("Started this album");
    expect(row("Nils")?.textContent).toContain("Can add photos");
    expect(row("Zed")?.textContent).toContain("Can only look");
    for (const r of rows) {
      const nameLine = r.querySelector("p")?.textContent ?? "";
      expect(nameLine).not.toMatch(/Started this album|Can add photos|Can only look/);
    }
  });

  test("the role line wraps instead of being cut off", () => {
    syncActor.send(statusSeen.create({ status: mixed }));
    people.open();
    const host = document.createElement("div");
    render(albumView("f1"), host);
    const line = host.querySelector('[data-copy-id="member.role_collaborator"]');
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
    expect(captionFor("creator")).toBe("You made this album. You decide who joins.");
    expect(captionFor("member")).toBe("You can add photos.");
    expect(captionFor("reader")).toBe("You can see every photo but not add any.");
  });

  test("a waiting joiner sees the waiting line and no caption", () => {
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
    expect(own?.textContent).not.toMatch(/Started this album|Can add photos|Can only look/);
    expect(own?.textContent).toContain("Waiting to be let in");
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
    expect(host.textContent).not.toContain("Can only look");
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
      previews: [],
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
    expect(rows[0]?.textContent).not.toContain("in full");
    expect(rows[1]?.textContent).toContain("· has 2 in full");
    expect(rows[2]?.textContent).toContain("· phone hasn't said yet");
    expect(host.textContent).not.toContain("A phone gets a photo");
  });

  test("plan 516 Try it: Kim holds 2 of 3, her line is exactly that", async () => {
    const host = await open([
      photo("a", "f1", true),
      photo("b", "f1", true),
      photo("c", "f1", false),
    ]);
    const line = memberRows(host)[1]
      .querySelector('[data-copy-id="member.role_collaborator"]')!
      .closest("p")!;
    expect(line.textContent?.trim()).toBe("Can add photos · has 2 in full");
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
    expect(after.textContent?.trim()).toBe(
      "Connected means they have Justus open and your phone can reach them right now.",
    );
    expect(section.textContent).not.toContain("Viewers see every photo");
  });

  test("an album with no photos says nothing about holdings", async () => {
    const host = await open([]);
    expect(host.textContent).not.toContain("on their phone");
    expect(host.textContent).not.toContain("A phone gets a photo");
  });

  test("solo album: the caption does not point at lines that are not there", async () => {
    vi.mocked(gateway.list).mockResolvedValue([
      null,
      { photos: [photo("a", "f1", false)] },
    ] as never);
    syncActor.send(
      statusSeen.create({
        status: {
          ...status,
          members: [status.members[0]],
          folder: { ...status.folder, members: 1 },
        } as unknown as SyncStatus,
      }),
    );
    people.open();
    await gallery.load();
    const host = document.createElement("div");
    render(albumView("f1"), host);
    const rows = memberRows(host);
    expect(rows.some((r) => /on their phone/.test(r.textContent ?? ""))).toBe(false);
  });

  test("a member's role and phone are one line", async () => {
    const host = await open([photo("a", "f1", true), photo("b", "f1", false)]);
    const lines = [...memberRows(host)[1].querySelectorAll("p")].filter((p) =>
      p.textContent?.includes("in full"),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].textContent).toMatch(/^[^·]+ · has \d+ in full$/);
    expect(lines[0].classList.contains("truncate")).toBe(false);
  });

  test("repro 662: own row line is the role part only, with and without photos", async () => {
    for (const photos of [[photo("a", "f1", true)], []]) {
      const host = await open(photos);
      const own = memberRows(host)[0];
      const line = own.querySelector('[data-copy-id^="member.role_"]')!.closest("p")!;
      expect(line.textContent?.trim()).toBe("Started this album");
    }
  });

  test("repro 662: a Viewer row says none, then some, on their phone (plan #490 Try it)", async () => {
    const withViewer = {
      ...status,
      members: [status.members[0], { ...status.members[1], viewer: true }],
      folder: { ...status.folder, members: 2 },
    } as unknown as SyncStatus;
    const photos = (kimHas: boolean) => [
      photo("a", "f1", kimHas),
      photo("b", "f1", false),
      photo("c", "f1", false),
    ];
    vi.mocked(gateway.list).mockResolvedValue([null, { photos: photos(false) }] as never);
    syncActor.send(statusSeen.create({ status: withViewer }));
    people.open();
    await gallery.load();
    const host = document.createElement("div");
    render(albumView("f1"), host);
    const line = () =>
      memberRows(host)[1]
        .querySelector('[data-copy-id="member.role_viewer"]')!
        .closest("p")!
        .textContent?.trim();
    expect(line()).toBe("Can only look · has no photos yet");
    vi.mocked(gateway.list).mockResolvedValue([null, { photos: photos(true) }] as never);
    await gallery.load();
    await vi.waitFor(() => expect(line()).toBe("Can only look · has 1 in full"));
  });

  test("an Admin row seen by a collaborator also says what their phone holds", async () => {
    const asMember = {
      ...status,
      members: [
        { ...status.members[0], admin: false },
        { ...status.members[1], admin: true },
      ],
      folder: { ...status.folder, role: "member", members: 2 },
    } as unknown as SyncStatus;
    vi.mocked(gateway.list).mockResolvedValue([
      null,
      { photos: [photo("a", "f1", false)] },
    ] as never);
    syncActor.send(statusSeen.create({ status: asMember }));
    people.open();
    await gallery.load();
    const host = document.createElement("div");
    render(albumView("f1"), host);
    const line = memberRows(host)[1]
      .querySelector('[data-copy-id="member.role_admin"]')!
      .closest("p")!;
    expect(line.textContent?.trim()).toBe("Started this album · has no photos yet");
  });

  test("a holders push updates the same row", async () => {
    const host = await open([photo("a", "f1", true), photo("b", "f1", false)]);
    const kim = memberRows(host)[1];
    expect(kim?.textContent).toContain("has 1 in full");
    vi.mocked(gateway.list).mockResolvedValue([
      null,
      { photos: [photo("a", "f1", true), photo("b", "f1", true)] },
    ] as never);
    await gallery.load();
    await vi.waitFor(() => expect(kim?.textContent).toContain("has all in full"));
    expect(memberRows(host)[1]).toBe(kim);
  });
});

describe("Add photos on the album page", () => {
  afterEach(() => vi.restoreAllMocks());

  const mountWith = (role: string, notice?: unknown) => {
    syncActor.send(
      statusSeen.create({
        status: {
          ...status,
          folder: { ...status.folder, role, notice },
        } as unknown as SyncStatus,
      }),
    );
    people.open();
    const host = document.createElement("div");
    render(albumView("f1"), host);
    return host;
  };

  test("an Admin gets the page's one coloured button, beside See photos", () => {
    const host = mountWith("creator");
    const add = buttonNamed(host, /^Add photos$/)!;
    expect(add.classList.contains("bg-action")).toBe(true);
    expect(add.classList.contains("text-on-action")).toBe(true);
    expect(add.classList.contains("ui-btn-primary")).toBe(false);
    expect(add.classList.contains("bg-accent")).toBe(false);
    expect(
      [...host.querySelectorAll(".ui-btn-primary, .bg-action")]
        .filter((b) => !b.closest('li[data-motion-key^="request:"]'))
        .map((b) => flat(b).trim()),
    ).toEqual(["Add photos"]);
    expect(host.textContent).toContain("See photos in this album");
  });

  test("after Create album the page's heading has focus", async () => {
    focusOnArrival("f1");
    const host = mountWith("creator");
    document.body.append(host);
    await vi.waitFor(() => expect(document.activeElement).toBe(host.querySelector("h1")));
  });

  test("a Collaborator gets it too", () => {
    expect(buttonNamed(mountWith("member"), /^Add photos$/)).toBeDefined();
  });

  test("a Viewer, or someone removed, gets only See photos", () => {
    for (const host of [mountWith("reader"), mountWith("member", { kind: "removed" })]) {
      expect(buttonNamed(host, /^Add photos$/)).toBeUndefined();
      expect(host.textContent).toContain("See photos in this album");
    }
  });

  test("on the phone the button picks, adds and opens the album", async () => {
    (window as { BareShell?: boolean }).BareShell = true;
    const addMany = vi.spyOn(gallery, "addMany").mockImplementation(() => {});
    const real = foldersActor.snapshot();
    vi.spyOn(foldersActor, "snapshot").mockReturnValue({
      ...real,
      context: { ...real.context, folders: [status.folder] },
    } as never);
    vi.mocked(gateway.media.pickMany).mockResolvedValueOnce([
      undefined,
      { items: [{ path: "/a.jpg", name: "a.jpg" }] },
    ] as never);
    history.pushState(null, "", "/sharing/f1");
    await gallery.load();
    const host = mountWith("creator");
    await vi.waitFor(() => expect(buttonNamed(host, /^Add photos$/)!.disabled).toBe(false));
    buttonNamed(host, /^Add photos$/)!.click();
    await vi.waitFor(() => expect(location.pathname).toBe("/albums/f1"));
    expect(addMany).toHaveBeenCalledTimes(1);
    (window as { BareShell?: boolean }).BareShell = false;
  });

  test("a pick adds the photos and opens the album", () => {
    history.pushState(null, "", "/sharing/f1");
    const addMany = vi.spyOn(gallery, "addMany").mockImplementation(() => {});
    const host = mountWith("creator");
    const input = host.querySelector<HTMLInputElement>("input[type=file]")!;
    const file = new File(["x"], "a.png", { type: "image/png" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    input.dispatchEvent(new Event("change"));
    expect(addMany).toHaveBeenCalledWith([{ kind: "file", file }], "f1");
    expect(location.pathname).toBe("/albums/f1");
  });
});

describe("Add photos waits for the gallery", () => {
  test("disabled while a batch runs, so a pick is never dropped", async () => {
    syncActor.send(statusSeen.create({ status }));
    people.open();
    await gallery.load();
    const host = document.createElement("div");
    render(albumView("f1"), host);
    const add = () => buttonNamed(host, /^Add photos$/) as HTMLButtonElement;
    await vi.waitFor(() => expect(add().disabled).toBe(false));
    vi.mocked(gateway.add).mockReturnValueOnce(new Promise(() => {}) as never);
    gallery.addMany([{ kind: "path", path: "/a.jpg", name: "a.jpg" }], "f1");
    await vi.waitFor(() => expect(add().disabled).toBe(true));
  });
});
