import { Actor, event, state, machine, type Clock } from "@mantaq/core";
import type { Photo, SyncStatus } from "@justus/core";
import { PRESENCE_TICK_MS, type PresenceClock } from "../utils/presence";
import { galleryActor, type GalleryActor } from "./gallery-machine";
import { syncActor, type SyncActor } from "./sync-machine";

/**
 * The clock behind "Phone off, last seen ...": while some friend's phone is not connected it
 * moves `now` on every 15 seconds, so the words and the 30 second off rule stay true.
 */

/** Every other member's phone is connected, and no listed photo waits for a phone that is not. Nothing counts time. */
const everyoneConnected = state("everyoneConnected")();
/** Some member's phone is not connected right now, perhaps only for a moment. Every 15 s the clock moves on. */
const someoneNotConnected = state("someoneNotConnected")();

/** A new sync status or photo list arrived. */
export const membersChanged = event("MEMBERS_CHANGED")<{ someoneNotConnected: boolean }>();
/** 15 s passed while someone was not connected. */
const clockTicked = event("CLOCK_TICKED")();

/** The tick runs on `clock`, so tests and the flow inspector can drive it. */
export const presenceClockMachine = machine("presenceClock", {
  create: (options: { clock: Clock }) => {
    return Actor({
      inputs: [membersChanged],
      internal: [clockTicked],
      outputs: [],
      states: [everyoneConnected, someoneNotConnected],
      initial: everyoneConnected,
      clock: options.clock,
      context: { now: options.clock.now() } as PresenceClock,
      setup: (m) => {
        /** Someone's phone is not connected: the clock starts ticking. */
        m.on(everyoneConnected, {
          event: membersChanged,
          to: [someoneNotConnected, everyoneConnected],
          handler: (e, opts) => {
            opts.context.set({ now: options.clock.now() });
            return {
              state: e.payload.someoneNotConnected ? someoneNotConnected : everyoneConnected,
            };
          },
        });
        // Returning `{}` keeps the running interval; returning the same state would restart it.
        /** Still someone away: the clock carries on, and stops once everyone is connected. */
        m.on(someoneNotConnected, {
          event: membersChanged,
          to: [everyoneConnected],
          handler: (e, opts) => {
            opts.context.set({ now: options.clock.now() });
            return e.payload.someoneNotConnected ? {} : { state: everyoneConnected };
          },
        });
        /** 15 s passed: the clock moves on. */
        m.on(someoneNotConnected, {
          event: clockTicked,
          to: [],
          handler: (_e, opts) => {
            opts.context.set({ now: options.clock.now() });
            return {};
          },
        });
        /** While someone is away a tick fires every 15 s; it stops when everyone is back. */
        m.effect(someoneNotConnected, {
          name: "someoneNotConnected",
          sends: [clockTicked],
          fn: (input) => {
            options.clock.setInterval(PRESENCE_TICK_MS, {
              cb: () => input.emit(clockTicked.create()),
              signal: input.signal,
            });
          },
        });
      },
    });
  },
});

export const presenceClockActor = presenceClockMachine.create();

export type PresenceClockActor = ReturnType<typeof presenceClockMachine.create>;

/** Feeds the clock whether some friend's phone is not connected: a member of the open album, or someone a listed photo is waiting for.
 * It acts only on a new status or a new photo list, and once on the current ones. */
export function wirePresenceClock(
  clock: PresenceClockActor,
  from: { sync: SyncActor; gallery: GalleryActor },
): () => void {
  let lastStatus: SyncStatus | null | undefined;
  let lastPhotos: Photo[] | undefined;
  const act = () => {
    const status = from.sync.snapshot().context.status;
    const photos = from.gallery.snapshot().context.photos;
    if (status === lastStatus && photos === lastPhotos) return;
    lastStatus = status;
    lastPhotos = photos;
    const someoneAway =
      (status?.members.slice(1).some((m) => !m.connected) ?? false) ||
      photos.some(
        (p) => p.holders?.kind === "inAlbum" && p.holders.waiting.some((m) => !m.connected),
      );
    clock.send(membersChanged.create({ someoneNotConnected: someoneAway }));
  };
  act();
  const stopSync = from.sync.on("change", { fn: act });
  const stopGallery = from.gallery.on("change", { fn: act });
  return () => {
    stopSync();
    stopGallery();
  };
}

wirePresenceClock(presenceClockActor, { sync: syncActor, gallery: galleryActor });
