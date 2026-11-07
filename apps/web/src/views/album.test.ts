// @vitest-environment happy-dom
import { describe, expect, test, vi } from "vite-plus/test";
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
