import { Actor, RealClock, event, state, type Clock } from "@mantaq/core";
import { withTimeout } from "@mantaq/sugar";
import { atom, computed } from "nanostores";
import { REACH_HINT_AFTER_MS, reachHintText, unreachableMember } from "../utils/reach-hint";
import { bindStateAtoms } from "./actor-utils";
import { $syncStatus } from "./sync-machine";

/**
 * Failed-connection hint: once every other member has stayed unreachable for
 * about 30 seconds, show a calm line suggesting WiFi. Purely time-based.
 */

type ReachContext = { name: string };

const REACH_STATES = ["reachable", "trying", "hint"] as const;
export type ReachStateName = (typeof REACH_STATES)[number];

export const $reachState = atom<ReachStateName>("reachable");
export const $reachName = atom("");
export const $reachError = atom<string | null>(null);
export const $reachFatal = atom(false);

export const $reachHint = computed([$reachState, $reachName], (state, name) =>
  state === "hint" ? reachHintText(name) : null,
);

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

reachActor.on("change", {
  fn: (snapshot) => {
    $reachName.set(snapshot.context.name);
  },
});

bindStateAtoms({
  actor: reachActor,
  states: REACH_STATES,
  $state: $reachState,
  $error: $reachError,
  $fatal: $reachFatal,
});

$syncStatus.subscribe((status) => {
  const name = unreachableMember(status);
  if (name === null) reachActor.send(reached.create());
  else reachActor.send(unreachable.create({ name }));
});
