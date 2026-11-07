import type { Snapshot } from "@mantaq/core";

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

/** Calls `fn(next, prev)` when the actor's state name changes (like an atom
 * listener). Not called on subscribe. Built on `change` rather than
 * `transition` because a dying actor emits no transition. */
export function onStateChange<S extends string>(
  actor: {
    snapshot(): Snapshot<unknown>;
    on(event: "change", options: { fn: (snapshot: Snapshot<unknown>) => void }): () => void;
  },
  states: readonly S[],
  fn: (next: S, prev: S) => void,
): () => void {
  const nameOf = stateNameOf<S>(states);
  let last = nameOf(actor.snapshot());
  return actor.on("change", {
    fn: (snapshot) => {
      const next = nameOf(snapshot);
      if (next === last) return;
      const prev = last;
      last = next;
      fn(next, prev);
    },
  });
}
