import { Actor, RealClock, event, state } from "@mantaq/core";
import { atom, computed } from "nanostores";
import { REACH_HINT_AFTER_MS, reachHintText, unreachableMember } from "../utils/reach-hint";
import { bindStateAtoms } from "./actor-utils";
import { $syncStatus } from "./sync-machine";

/**
 * Failed-connection hint: once every other member has stayed unreachable for
 * about 30 seconds, show a calm line suggesting WiFi. Purely time-based.
 */

const REACH_STATES = ["reachable", "trying", "hint"] as const;
export type ReachStateName = (typeof REACH_STATES)[number];

export const $reachState = atom<ReachStateName>("reachable");
export const $reachName = atom("");
export const $reachError = atom<string | null>(null);
export const $reachFatal = atom(false);

export const $reachHint = computed([$reachState, $reachName], (state, name) =>
  state === "hint" ? reachHintText(name) : null,
);

const reachable = state("reachable")();
const trying = state("trying")();
const hint = state("hint")();

const unreachable = event("UNREACHABLE")<{ name: string }>();
const reached = event("REACHED")();
const due = event("DUE")();

const reachActor = new Actor({
  inputs: [unreachable, reached],
  internal: [due],
  outputs: [],
  states: [reachable, trying, hint],
  initial: reachable,
  clock: new RealClock(),
  context: {},
  setup: (m) => {
    m.on(reachable, unreachable, (e) => {
      $reachName.set(e.payload.name);
      return { state: trying };
    });
    // Keep the timer running; only the name to mention may change.
    m.on(trying, unreachable, (e) => {
      $reachName.set(e.payload.name);
      return { state: trying };
    });
    m.on(hint, unreachable, (e) => {
      $reachName.set(e.payload.name);
      return { state: hint };
    });
    m.on(trying, reached, () => ({ state: reachable }));
    m.on(hint, reached, () => ({ state: reachable }));

    m.effect(trying, ({ signal, emit }) => {
      return new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          emit(due.create());
          resolve();
        }, REACH_HINT_AFTER_MS);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    });
    m.on(trying, due, () => ({ state: hint }));
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
