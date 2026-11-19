import { Actor, event, state, machine, type Clock } from "@mantaq/core";
import type { SyncStatus } from "@justus/core";
import { PRESENCE_TICK_MS, type PresenceClock } from "../utils/presence";
import { syncActor, type SyncActor } from "./sync-machine";

/**
 * The clock behind "Phone off, last seen ...": while some friend's phone is not connected it
 * moves `now` on every 15 seconds, so the words and the 30 second off rule stay true.
 */

/** Every other member's phone is connected, or nobody else is in the album. Nothing counts time. */
const everyoneConnected = state("everyoneConnected")();
/** Some member's phone is not connected right now, perhaps only for a moment. Every 15 s the clock moves on. */
const someoneNotConnected = state("someoneNotConnected")();

/** A new sync status arrived. */
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

/** Feeds the sync status to the clock. It acts only on a new status object, never on an unrelated
 * change such as an error, and once on the current status. */
export function wirePresenceClockToSync(clock: PresenceClockActor, sync: SyncActor): () => void {
  let lastStatus: SyncStatus | null | undefined;
  const act = (status: SyncStatus | null) => {
    if (status === lastStatus) return;
    lastStatus = status;
    const someoneAway = status?.members.slice(1).some((m) => !m.connected) ?? false;
    clock.send(membersChanged.create({ someoneNotConnected: someoneAway }));
  };
  act(sync.snapshot().context.status);
  return sync.on("change", { fn: (snapshot) => act(snapshot.context.status) });
}

wirePresenceClockToSync(presenceClockActor, syncActor);
