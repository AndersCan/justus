import { Actor, RealClock, event, state, type Snapshot } from "@mantaq/core";
import { atom } from "nanostores";
import type { SyncStatus } from "@justus/core";
import { gateway } from "../gateway";

/**
 * The sync/join state machine: folder status, reader join, creator enroll.
 * Same pattern as the gallery — a mantaq actor whose context holds atoms,
 * with every invoke wrapped so transport failures become failure events.
 */

export type SyncStateName = "idle" | "refreshing" | "ok" | "joining" | "enrolling" | "error";

const STATE_NAMES: ReadonlySet<string> = new Set([
  "idle",
  "refreshing",
  "ok",
  "joining",
  "enrolling",
  "error",
]);

export const $syncStatus = atom<SyncStatus | null>(null);
export const $syncState = atom<SyncStateName>("idle");
export const $syncBusy = atom<boolean>(false);
export const $syncError = atom<string | null>(null);

const idle = state("idle")();
const refreshing = state("refreshing")();
const ok = state("ok")();
const joining = state("joining")();
const enrolling = state("enrolling")();
const error = state("error")();

const refresh = event("REFRESH")();
const status = event("STATUS")<{ status: SyncStatus }>();
const statusFailed = event("STATUS_FAILED")<{ message: string }>();
const join = event("JOIN")<{ key: string }>();
const joined = event("JOINED")<{ status: SyncStatus }>();
const joinFailed = event("JOIN_FAILED")<{ message: string }>();
const enroll = event("ENROLL")<{ key: string; name: string }>();
const enrolled = event("ENROLLED")<{ status: SyncStatus }>();
const enrollFailed = event("ENROLL_FAILED")<{ message: string }>();
const retry = event("RETRY")();

type SyncContext = {
  $status: typeof $syncStatus;
  $busy: typeof $syncBusy;
  $error: typeof $syncError;
  pendingJoin: string | null;
  pendingEnroll: { key: string; name: string } | null;
};

function runInvoke(
  signal: AbortSignal,
  work: () => Promise<[unknown, unknown]>,
  onSuccess: (result: unknown) => void,
  onFailure: (message: string) => void,
) {
  void (async () => {
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

const syncActor = new Actor({
  inputs: [refresh, join, enroll, retry],
  internal: [status, statusFailed, joined, joinFailed, enrolled, enrollFailed],
  outputs: [],
  states: [idle, refreshing, ok, joining, enrolling, error],
  initial: idle,
  clock: new RealClock(),
  context: {
    $status: $syncStatus,
    $busy: $syncBusy,
    $error: $syncError,
    pendingJoin: null,
    pendingEnroll: null,
  } as SyncContext,
  setup: (m) => {
    m.on(idle, refresh, () => ({ state: refreshing }));
    m.on(ok, refresh, () => ({ state: refreshing }));
    m.on(error, refresh, () => ({ state: refreshing }));
    m.on(error, retry, () => ({ state: refreshing }));

    m.effect(refreshing, ({ signal, emit }) => {
      runInvoke(
        signal,
        () => gateway.status(),
        (result) =>
          result
            ? emit(status.create({ status: result as SyncStatus }))
            : emit(statusFailed.create({ message: "no status returned" })),
        (message) => emit(statusFailed.create({ message })),
      );
    });
    m.on(refreshing, status, (e, opts) => {
      const s = opts.context.get();
      s.$status.set(e.payload.status);
      s.$error.set(null);
      return { state: ok };
    });
    m.on(refreshing, statusFailed, (e, opts) => {
      opts.context.get().$error.set(e.payload.message);
      return { state: error };
    });

    m.on(ok, join, (e, opts) => {
      const s = opts.context.get();
      s.$busy.set(true);
      s.$error.set(null);
      opts.context.set({ ...s, pendingJoin: e.payload.key });
      return { state: joining };
    });
    m.effect(joining, ({ signal, emit, context }) => {
      const key = context.get().pendingJoin;
      if (!key) {
        emit(joinFailed.create({ message: "no pending join key" }));
        return;
      }
      runInvoke(
        signal,
        () => gateway.join(key),
        (result) =>
          result
            ? emit(joined.create({ status: result as SyncStatus }))
            : emit(joinFailed.create({ message: "join returned no status" })),
        (message) => emit(joinFailed.create({ message })),
      );
    });
    m.on(joining, joined, (e, opts) => {
      const s = opts.context.get();
      s.$busy.set(false);
      s.$error.set(null);
      s.$status.set(e.payload.status);
      opts.context.set({ ...s, pendingJoin: null });
      return { state: ok };
    });
    m.on(joining, joinFailed, (e, opts) => {
      const s = opts.context.get();
      s.$busy.set(false);
      s.$error.set(e.payload.message);
      opts.context.set({ ...s, pendingJoin: null });
      return { state: ok };
    });

    m.on(ok, enroll, (e, opts) => {
      const s = opts.context.get();
      s.$busy.set(true);
      s.$error.set(null);
      opts.context.set({
        ...s,
        pendingEnroll: { key: e.payload.key, name: e.payload.name },
      });
      return { state: enrolling };
    });
    m.effect(enrolling, ({ signal, emit, context }) => {
      const pending = context.get().pendingEnroll;
      if (!pending) {
        emit(enrollFailed.create({ message: "no pending enrollment" }));
        return;
      }
      runInvoke(
        signal,
        () => gateway.enroll(pending.key, pending.name),
        (result) =>
          result
            ? emit(enrolled.create({ status: result as SyncStatus }))
            : emit(enrollFailed.create({ message: "enroll returned no status" })),
        (message) => emit(enrollFailed.create({ message })),
      );
    });
    m.on(enrolling, enrolled, (e, opts) => {
      const s = opts.context.get();
      s.$busy.set(false);
      s.$error.set(null);
      s.$status.set(e.payload.status);
      opts.context.set({ ...s, pendingEnroll: null });
      return { state: ok };
    });
    m.on(enrolling, enrollFailed, (e, opts) => {
      const s = opts.context.get();
      s.$busy.set(false);
      s.$error.set(e.payload.message);
      opts.context.set({ ...s, pendingEnroll: null });
      return { state: ok };
    });
  },
});

const nameOf = (snapshot: Snapshot<SyncContext>) => {
  const name = snapshot.path[0] as string;
  return (STATE_NAMES.has(name) ? name : "error") as SyncStateName;
};

syncActor.on("change", (snapshot) => {
  $syncState.set(nameOf(snapshot));
});

export const sync = {
  state: () => nameOf(syncActor.snapshot()),
  refresh: () => syncActor.send(refresh.create()),
  join: (key: string) => syncActor.send(join.create({ key })),
  enroll: (key: string, name: string) => syncActor.send(enroll.create({ key, name })),
  retry: () => syncActor.send(retry.create()),
};
