// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { render } from "lit-html";
import type { SyncStatus } from "@justus/core";
import { friends, friendsActor } from "../machines/friends-machine";
import { people, peopleActor } from "../machines/people-machine";
import { statusSeen, syncActor } from "../machines/sync-machine";
import { albumView } from "./album";

vi.mock("../gateway", () => ({
  gateway: {
    friends: {
      list: vi.fn(async () => [null, { friends: [] }]),
      add: vi.fn(async (identity: string, name: string) => [null, { friend: { identity, name } }]),
    },
    requests: vi.fn().mockResolvedValue([null, { requests: [] }]),
    removeMember: vi.fn(),
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
