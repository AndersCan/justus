import { VirtualClock } from "@mantaq/core";
import type { Photo, SyncStatus } from "@justus/core";
import { describe, expect, test, vi } from "vite-plus/test";
import { PRESENCE_TICK_MS } from "../utils/presence";
import { membersChanged, presenceClockMachine, wirePresenceClock } from "./presence-clock-machine";
import { galleryMachine } from "./gallery-machine";
import { statusSeen, syncMachine } from "./sync-machine";

const away = membersChanged.create({ someoneNotConnected: true });
const back = membersChanged.create({ someoneNotConnected: false });

test("someone away starts the clock and it moves on every 15 s", () => {
  const clock = VirtualClock();
  const actor = presenceClockMachine.create({ clock });
  expect(actor.snapshot().path[0]).toBe("everyoneConnected");
  actor.send(away);
  expect(actor.snapshot().path[0]).toBe("someoneNotConnected");
  clock.advance(PRESENCE_TICK_MS);
  expect(actor.snapshot().context.now).toBe(15_000);
  clock.advance(PRESENCE_TICK_MS);
  expect(actor.snapshot().context.now).toBe(30_000);
});

test("a second away status does not restart the interval", () => {
  const clock = VirtualClock();
  const actor = presenceClockMachine.create({ clock });
  actor.send(away);
  clock.advance(10_000);
  actor.send(away);
  clock.advance(5_000);
  expect(actor.snapshot().context.now).toBe(15_000);
  clock.advance(15_000);
  expect(actor.snapshot().context.now).toBe(30_000);
});

test("everyone back stops the ticks", () => {
  const clock = VirtualClock();
  const actor = presenceClockMachine.create({ clock });
  actor.send(away);
  clock.advance(20_000);
  actor.send(back);
  expect(actor.snapshot().path[0]).toBe("everyoneConnected");
  expect(actor.snapshot().context.now).toBe(20_000);
  expect(clock.hasPending()).toBe(false);
});

test("an all-connected status changes nothing", () => {
  const clock = VirtualClock();
  const actor = presenceClockMachine.create({ clock });
  clock.advance(5_000);
  actor.send(back);
  expect(actor.snapshot().path[0]).toBe("everyoneConnected");
  expect(clock.hasPending()).toBe(false);
});

test("the first away status stamps now, so a friend who just left is still inside the 30 s", () => {
  const clock = VirtualClock();
  const actor = presenceClockMachine.create({ clock });
  clock.advance(600_000);
  actor.send(away);
  expect(actor.snapshot().context.now).toBe(600_000);
});

describe("wirePresenceClock", () => {
  const status = (others: boolean[]) =>
    ({
      members: [
        { key: "me", name: "Ada", admin: true, connected: false },
        ...others.map((connected, i) => ({ key: `k${i}`, name: `F${i}`, admin: false, connected })),
      ],
    }) as SyncStatus;

  const photoWaiting = (connected: boolean) =>
    ({
      id: "p",
      holders: { kind: "inAlbum", waiting: [{ key: "b", name: "Ben", connected }] },
    }) as unknown as Photo;
  const listed = (photos: Photo[]) => ({ type: "PHOTOS_LOADED", payload: { photos } }) as never;

  function wired(first: SyncStatus | null) {
    const clock = VirtualClock();
    const sync = syncMachine.create({
      clock,
      gateway: { status: async () => [null, null] } as never,
    });
    if (first !== null) sync.send(statusSeen.create({ status: first }));
    const actor = presenceClockMachine.create({ clock });
    const gallery = galleryMachine.create({
      gateway: { list: () => new Promise(() => {}) } as never,
    });
    wirePresenceClock(actor, { sync, gallery });
    gallery.send({ type: "LOAD" } as never);
    return { sync, actor, gallery };
  }

  test("a friend not connected starts the clock", () => {
    expect(wired(status([true, false])).actor.state.name).toBe("someoneNotConnected");
  });

  test("everyone else connected keeps it still, even when the own row reads not connected", () => {
    expect(wired(status([true, true])).actor.state.name).toBe("everyoneConnected");
  });

  test("no status yet keeps it still", () => {
    expect(wired(null).actor.state.name).toBe("everyoneConnected");
  });

  test("a new status with everyone back stops it", () => {
    const { sync, actor } = wired(status([false]));
    sync.send(statusSeen.create({ status: status([true]) }));
    expect(actor.state.name).toBe("everyoneConnected");
  });

  test("a listed photo waiting for a phone that is not connected starts it", () => {
    const { gallery, actor } = wired(status([true]));
    expect(actor.state.name).toBe("everyoneConnected");
    gallery.inject(listed([photoWaiting(false)]));
    expect(actor.state.name).toBe("someoneNotConnected");
  });

  test("a list where that friend is connected stops it", () => {
    const { gallery, actor } = wired(status([true]));
    gallery.inject(listed([photoWaiting(false)]));
    gallery.send({ type: "LOAD" } as never);
    gallery.inject(listed([photoWaiting(true)]));
    expect(actor.state.name).toBe("everyoneConnected");
  });

  test("photos with unknown or removed holders are passed over, not fatal", () => {
    const { gallery, actor } = wired(status([true]));
    const bare = { id: "q" } as unknown as Photo;
    const removed = { id: "r", holders: { kind: "removed", here: true } } as unknown as Photo;
    gallery.inject(listed([bare, removed]));
    expect(actor.state.name).toBe("everyoneConnected");
    gallery.send({ type: "LOAD" } as never);
    gallery.inject(listed([bare, removed, photoWaiting(false)]));
    expect(actor.state.name).toBe("someoneNotConnected");
  });

  test("the same status and list again send nothing", () => {
    const { gallery, actor, sync } = wired(status([true]));
    const send = vi.spyOn(actor, "send");
    sync.send(statusSeen.create({ status: sync.snapshot().context.status as SyncStatus }));
    expect(send).toHaveBeenCalledTimes(0);
    gallery.send({ type: "LOAD" } as never);
    expect(send).toHaveBeenCalledTimes(0);
  });
});
