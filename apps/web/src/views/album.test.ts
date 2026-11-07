// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { render } from "lit-html";
import type { SyncStatus } from "@justus/core";
import { friends, friendsActor } from "../machines/friends-machine";
import { people, peopleActor } from "../machines/people-machine";
import { statusSeen, syncActor } from "../machines/sync-machine";
import { requests } from "../machines/requests-machine";
import { gateway } from "../gateway";
import { albumView } from "./album";
import { toast } from "./toast";

vi.mock("./toast", () => ({ toast: vi.fn() }));

vi.mock("../gateway", () => ({
  gateway: {
    friends: {
      list: vi.fn(async () => [null, { friends: [] }]),
      add: vi.fn(async (identity: string, name: string) => [null, { friend: { identity, name } }]),
    },
    requests: vi.fn().mockResolvedValue([null, { requests: [] }]),
    removeMember: vi.fn(),
    makeMember: vi.fn().mockResolvedValue([null, { ok: true }]),
    respond: vi.fn().mockResolvedValue([null, { ok: true }]),
    logs: { view: vi.fn(), clear: vi.fn() },
  },
}));

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
  const ask = (requesterKey: string, viaInvite: boolean) => ({
    folderId: "f1",
    folderName: "Trip",
    requesterKey,
    requesterName: requesterKey,
    shareKey: "s",
    requestedAt: Date.now(),
    ...(viaInvite ? { viaInvite } : {}),
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
  const button = (host: HTMLElement, text: string) =>
    [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);

  test("an invite request offers both accepts and the caption; each sends its role", async () => {
    const host = await show([ask("nils", true)]);
    expect(host.textContent).toContain(
      "A Viewer sees every photo. A Collaborator can add photos too.",
    );
    expect(button(host, "Accept")).toBeUndefined();
    button(host, "Accept as Viewer")!.click();
    await vi.waitFor(() =>
      expect(gateway.respond).toHaveBeenCalledWith("f1", "nils", true, "reader"),
    );
  });

  test("Accept, and let them add photos sends the member role", async () => {
    const host = await show([ask("nils", true)]);
    button(host, "Accept, and let them add photos")!.click();
    await vi.waitFor(() =>
      expect(gateway.respond).toHaveBeenCalledWith("f1", "nils", true, "member"),
    );
  });

  test("a plain request keeps a single Accept that sends the member role", async () => {
    const host = await show([ask("ola", false)]);
    expect(host.textContent).not.toContain("A Viewer sees every photo");
    expect(button(host, "Accept as Viewer")).toBeUndefined();
    button(host, "Accept")!.click();
    await vi.waitFor(() =>
      expect(gateway.respond).toHaveBeenCalledWith("f1", "ola", true, "member"),
    );
  });
});

describe("album viewer rows", () => {
  test("a Viewer row says Viewer and can only look, with no dot and no Remove", () => {
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
    const row = memberRows(host)[1];
    expect(row.textContent).toContain("Viewer");
    expect(row.textContent).toContain("can only look");
    expect(row.querySelector("span.h-1\\.5")).toBeNull();
    expect(row.textContent).not.toContain("Remove");
    expect(host.textContent).toContain("Viewers see every photo but can't add any.");
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
    const button = host.querySelector<HTMLButtonElement>(
      'button[aria-label^="Let "][aria-label$=" add photos"]',
    );
    expect(button?.textContent).toContain("Let add photos");
    button?.click();
    await vi.waitFor(() => expect(gateway.makeMember).toHaveBeenCalledWith("f1", "k1"));
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith("Kimmy can add photos now"));
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
    const letButton = () =>
      host.querySelector<HTMLButtonElement>(
        'button[aria-label^="Let "][aria-label$=" add photos"]',
      );
    const removeButton = () =>
      [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
        b.textContent?.includes("Remove"),
      );
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
