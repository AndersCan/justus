import { Actor, RealClock, event, state, type Clock, type Snapshot } from "@mantaq/core";
import { withTimeout } from "@mantaq/sugar";
import type { SyncStatus } from "@justus/core";
import { REACH_HINT_AFTER_MS, reachHintText, unreachableMember } from "../utils/reach-hint";
import { stateNameOf } from "./actor-utils";
import { syncActor, type SyncActor } from "./sync-machine";

/**
 * Failed-connection hint: once every other member has stayed unreachable for
 * about 30 seconds, show a calm line suggesting WiFi. Purely time-based.
 */

type ReachContext = { name: string };

const REACH_STATES = ["reachable", "trying", "hint"] as const;
export type ReachStateName = (typeof REACH_STATES)[number];

const nameOf = stateNameOf(REACH_STATES);

/** The hint line to show, or null while there is nothing to say. */
export function reachHintOf(s: Snapshot<ReachContext>): string | null {
  return nameOf(s) === "hint" ? reachHintText(s.context.name) : null;
}

/** Everyone in the album can be reached, or there is nobody else yet; no hint is shown. */
const reachable = state("reachable")();
/** Every other member is out of reach; a short wait runs before a hint appears. */
const trying = state("trying")();
/** The wait is over and a calm line suggests checking WiFi. */
const hint = state("hint")();

/** The other members cannot be reached right now. */
const unreachable = event("UNREACHABLE")<{ name: string }>();
/** Someone in the album can be reached again. */
const reached = event("REACHED")();
/** About 30 seconds passed with nobody reachable. */
const due = event("DUE")();

/** The wait before the hint runs on `clock`, so tests and the flow inspector can drive it. */
export function createReachActor(options: { clock: Clock }) {
  return Actor({
    inputs: [unreachable, reached],
    internal: [due],
    outputs: [],
    states: [reachable, trying, hint],
    initial: reachable,
    clock: options.clock,
    context: { name: "" } as ReachContext,
    setup: (m) => {
      /** Nobody else can be reached: the wait starts and no hint is shown yet. */
      m.on(reachable, {
        event: unreachable,
        to: [trying],
        handler: (e, opts) => {
          opts.context.set({ name: e.payload.name });
          return { state: trying };
        },
      });
      // Keep the timer running; only the name to mention may change.
      /** Still nobody reachable: the wait carries on and the member named in the hint may change. */
      m.on(trying, {
        event: unreachable,
        to: [trying],
        handler: (e, opts) => {
          opts.context.set({ name: e.payload.name });
          return { state: trying };
        },
      });
      /** Still nobody reachable: the hint stays up and may name a different member. */
      m.on(hint, {
        event: unreachable,
        to: [hint],
        handler: (e, opts) => {
          opts.context.set({ name: e.payload.name });
          return { state: hint };
        },
      });
      /** Someone is reachable again before the wait ends: nothing is shown. */
      m.on(trying, { event: reached, to: [reachable], handler: () => ({ state: reachable }) });
      /** Someone is reachable again: the WiFi hint goes away. */
      m.on(hint, { event: reached, to: [reachable], handler: () => ({ state: reachable }) });

      /** A 30 second wait runs; it is cancelled if someone becomes reachable. */
      m.effect(trying, {
        name: "trying",
        sends: [due],
        fn: (input) => withTimeout(REACH_HINT_AFTER_MS, { input, event: () => due.create() }),
      });
      /** Nobody was reachable for the whole wait: the WiFi hint appears. */
      m.on(trying, { event: due, to: [hint], handler: () => ({ state: hint }) });
    },
  });
}

export const reachActor = createReachActor({ clock: RealClock() });

export type ReachActor = ReturnType<typeof createReachActor>;

/** Feeds the sync status to the reach actor. Each unreachable event can restart
 * the wait, so it acts only when sync holds a new status object, never on an
 * unrelated change such as an error. It also acts once on the current status. */
export function wireReachToSync(reach: ReachActor, sync: SyncActor): () => void {
  let lastStatus: SyncStatus | null | undefined;
  const act = (status: SyncStatus | null) => {
    if (status === lastStatus) return;
    lastStatus = status;
    const name = unreachableMember(status);
    if (name === null) reach.send(reached.create());
    else reach.send(unreachable.create({ name }));
  };
  act(sync.snapshot().context.status);
  return sync.on("change", { fn: (snapshot) => act(snapshot.context.status) });
}

wireReachToSync(reachActor, syncActor);
