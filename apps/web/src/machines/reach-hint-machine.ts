import { Actor, RealClock, event, state, type Clock, type Snapshot } from "@mantaq/core";
import { withTimeout } from "@mantaq/sugar";
import type { SyncStatus } from "@justus/core";
import {
  CONNECTING_FOR_MS,
  REACH_HINT_AFTER_MS,
  reachHintText,
  unreachableMember,
} from "../utils/reach-hint";
import { stateNameOf } from "./actor-utils";
import { syncActor, type SyncActor } from "./sync-machine";

/**
 * Failed-connection hint: for the first about 15 seconds with every other
 * member unreachable the album says it is connecting; after about 30 seconds
 * it shows a calm line suggesting WiFi. Purely time-based.
 */

type ReachContext = { name: string };

const REACH_STATES = [
  "noWifiHint",
  "tryingToReachMembers",
  "waitingBeforeWifiHint",
  "showingWifiHint",
] as const;

const nameOf = stateNameOf(REACH_STATES);

/** The hint line to show, or null while there is nothing to say. */
export function reachHintOf(s: Snapshot<ReachContext>): string | null {
  return nameOf(s) === "showingWifiHint" ? reachHintText(s.context.name) : null;
}

/** True once the first wait is over with nobody reachable, so the album may say nobody is connected. */
export function connectionGivenUp(s: Snapshot<ReachContext>): boolean {
  const name = nameOf(s);
  return name === "waitingBeforeWifiHint" || name === "showingWifiHint";
}

/** Everyone in the album can be reached, or there is nobody else yet; no hint is shown. */
const noWifiHint = state("noWifiHint")();
/** Every other member is out of reach; the album says it is connecting for a few seconds. */
const tryingToReachMembers = state("tryingToReachMembers")();
/** Still nobody reachable after the first wait; a second wait runs before a hint appears. */
const waitingBeforeWifiHint = state("waitingBeforeWifiHint")();
/** The wait is over and a calm line suggests checking WiFi. */
const showingWifiHint = state("showingWifiHint")();

/** The other members cannot be reached right now. */
const unreachable = event("UNREACHABLE")<{ name: string }>();
/** Someone in the album can be reached again. */
const reached = event("REACHED")();
/** About 15 seconds passed with nobody reachable. */
const connectingTimedOut = event("CONNECTING_TIMED_OUT")();
/** About 30 seconds passed with nobody reachable. */
const due = event("DUE")();

/** The wait before the hint runs on `clock`, so tests and the flow inspector can drive it. */
export function createReachActor(options: { clock: Clock }) {
  return Actor({
    inputs: [unreachable, reached],
    internal: [connectingTimedOut, due],
    outputs: [],
    states: [noWifiHint, tryingToReachMembers, waitingBeforeWifiHint, showingWifiHint],
    initial: noWifiHint,
    clock: options.clock,
    context: { name: "" } as ReachContext,
    setup: (m) => {
      /** Nobody else can be reached: the first wait starts and no hint is shown yet. */
      m.on(noWifiHint, {
        event: unreachable,
        to: [tryingToReachMembers],
        handler: (e, opts) => {
          opts.context.set({ name: e.payload.name });
          return { state: tryingToReachMembers };
        },
      });
      // Returning `{}` keeps the running timer; returning the same state would restart it.
      /** Still nobody reachable: the first wait carries on and the member named may change. */
      m.on(tryingToReachMembers, {
        event: unreachable,
        to: [],
        handler: (e, opts) => {
          opts.context.set({ name: e.payload.name });
          return {};
        },
      });
      /** Still nobody reachable: the second wait carries on and the member named may change. */
      m.on(waitingBeforeWifiHint, {
        event: unreachable,
        to: [],
        handler: (e, opts) => {
          opts.context.set({ name: e.payload.name });
          return {};
        },
      });
      /** Still nobody reachable: the hint stays and the member named may change. */
      m.on(showingWifiHint, {
        event: unreachable,
        to: [],
        handler: (e, opts) => {
          opts.context.set({ name: e.payload.name });
          return {};
        },
      });
      /** Someone is reachable again during the first wait: it ends. */
      m.on(tryingToReachMembers, {
        event: reached,
        to: [noWifiHint],
        handler: () => ({ state: noWifiHint }),
      });
      /** Someone is reachable again during the second wait: it ends. */
      m.on(waitingBeforeWifiHint, {
        event: reached,
        to: [noWifiHint],
        handler: () => ({ state: noWifiHint }),
      });
      /** Someone is reachable again: the WiFi hint goes away. */
      m.on(showingWifiHint, {
        event: reached,
        to: [noWifiHint],
        handler: () => ({ state: noWifiHint }),
      });

      /** A 15 second wait runs; it is cancelled if someone becomes reachable. */
      m.effect(tryingToReachMembers, {
        name: "tryingToReachMembers",
        sends: [connectingTimedOut],
        fn: (input) =>
          withTimeout(CONNECTING_FOR_MS, { input, event: () => connectingTimedOut.create() }),
      });
      /** Nobody was reachable for the first wait: the album stops saying it is connecting. */
      m.on(tryingToReachMembers, {
        event: connectingTimedOut,
        to: [waitingBeforeWifiHint],
        handler: () => ({ state: waitingBeforeWifiHint }),
      });
      /** The rest of the 30 seconds runs; it is cancelled if someone becomes reachable. */
      m.effect(waitingBeforeWifiHint, {
        name: "waitingBeforeWifiHint",
        sends: [due],
        fn: (input) =>
          withTimeout(REACH_HINT_AFTER_MS - CONNECTING_FOR_MS, {
            input,
            event: () => due.create(),
          }),
      });
      /** Nobody was reachable for the whole wait: the WiFi hint appears. */
      m.on(waitingBeforeWifiHint, {
        event: due,
        to: [showingWifiHint],
        handler: () => ({ state: showingWifiHint }),
      });
    },
  });
}

export const reachActor = createReachActor({ clock: RealClock() });

export type ReachActor = ReturnType<typeof createReachActor>;

/** Feeds the sync status to the reach actor. Each unreachable event is cheap
 * but pointless to repeat, so it acts only when sync holds a new status object, never on an
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
