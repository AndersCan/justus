import type { Snapshot, ErrorInfo } from "@mantaq/core";
import type { WritableAtom } from "nanostores";

/** Safe runner for an async invoke inside a mantaq effect: models rejections
 * as failure events instead of unhandled rejections (which would wedge the
 * machine in a busy state). Returns the promise so effects hand it to mantaq —
 * `settled()` then tracks the invoke instead of resolving early. */
export function runInvoke(
  signal: AbortSignal,
  work: () => Promise<[unknown, unknown]>,
  onSuccess: (result: unknown) => void,
  onFailure: (message: string) => void,
): Promise<void> {
  return (async () => {
    let outcome: [unknown, unknown];
    try {
      outcome = await work();
    } catch (e) {
      if (signal.aborted) return;
      onFailure(e instanceof Error ? e.message : String(e));
      return;
    }
    if (signal.aborted) return;
    const [err, result] = outcome;
    if (err) onFailure(err instanceof Error ? err.message : "unknown error");
    else onSuccess(result);
  })();
}

/** Maps an actor snapshot to its state name, normalising anything unknown to
 * "error" — the shared safety net every state atom in this app uses. */
export function stateNameOf<TState extends string>(states: readonly TState[]) {
  const known = new Set<string>(states);
  return (snapshot: Snapshot<unknown>): TState =>
    (known.has(snapshot.path[0] as string) ? snapshot.path[0] : "error") as TState;
}

/** Extracts mantaq's universal error state (`__error` — the machine is dead,
 * every later `send` is a no-op) from a snapshot; null while the machine is
 * alive. The UI must not offer Retry for a fatal machine — it can only reload. */
export function fatalErrorOf(snapshot: Snapshot<unknown>): { message: string } | null {
  const error = snapshot.error;
  if (!error) return null;
  const detail = error.error instanceof Error ? error.error.message : String(error.error);
  return { message: `Internal error (${error.reason}): ${detail}` };
}

/** The shared actor → nanostores binding every machine in this app uses: a
 * state atom mapped from the snapshot path, a fatal flag + message from
 * mantaq's `__error` state, and the state-name accessor. */
export function bindStateAtoms<State extends string>(args: {
  actor: {
    on(
      event: "change",
      fn: (snapshot: Snapshot<unknown>, prev: Snapshot<unknown>) => void,
    ): unknown;
    on(event: "error", fn: (info: ErrorInfo) => void): unknown;
    snapshot(): Snapshot<unknown>;
  };
  states: readonly State[];
  $state: WritableAtom<State>;
  $error: WritableAtom<string | null>;
  $fatal: WritableAtom<boolean>;
}): { state: () => State } {
  const nameOf = stateNameOf<State>(args.states);
  args.actor.on("change", (snapshot) => {
    args.$state.set(nameOf(snapshot));
    const fatal = fatalErrorOf(snapshot);
    args.$fatal.set(fatal !== null);
    if (fatal) args.$error.set(fatal.message);
  });
  // A construction-time death fires on("error") before any "change" — and
  // mantaq's Subscribers replays the buffered error to subscribers added
  // after construction — so wiring it here makes a silent __error observable.
  args.actor.on("error", (info) => {
    args.$fatal.set(true);
    const detail = info.error instanceof Error ? info.error.message : String(info.error);
    args.$error.set(`Internal error (${info.reason}): ${detail}`);
  });
  return { state: () => nameOf(args.actor.snapshot()) };
}
