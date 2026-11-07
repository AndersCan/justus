import { describe, expect, test, vi } from "vite-plus/test";
import { fatalErrorOf, onStateChange, runInvoke, stateNameOf } from "./actor-utils";

/** Minimal `Snapshot`-shaped object — the imported type is erased at runtime. */
function snapshot(path: string[], error?: unknown): any {
  return { path, error };
}

describe("stateNameOf", () => {
  const states = ["idle", "ok", "error"] as const;
  const toName = stateNameOf(states);

  test("maps a known state path to its name", () => {
    expect(toName(snapshot(["ok"]))).toBe("ok");
    expect(toName(snapshot(["idle"]))).toBe("idle");
  });

  test("normalises unknown paths to __error", () => {
    expect(toName(snapshot(["frobnicate"]))).toBe("__error");
    expect(toName(snapshot([]))).toBe("__error");
  });
});

describe("fatalErrorOf", () => {
  test("returns null when the machine is alive", () => {
    expect(fatalErrorOf(snapshot(["ok"]))).toBeNull();
  });

  test("surfaces mantaq's __error as a fatal message", () => {
    const fatal = fatalErrorOf(
      snapshot(["__error"], { error: new Error("boom"), reason: "throw" }),
    );
    expect(fatal).not.toBeNull();
    expect(fatal!.message).toContain("boom");
    expect(fatal!.message).toContain("throw");
  });

  test("stringifies non-Error fatal causes", () => {
    const fatal = fatalErrorOf(snapshot(["__error"], { error: "nope", reason: "reject" }));
    expect(fatal!.message).toContain("nope");
  });
});

describe("runInvoke", () => {
  const live = { aborted: false } as AbortSignal;

  test("delivers the result on success tuple [null, result]", async () => {
    const onSuccess = vi.fn();
    const onFailure = vi.fn();
    await runInvoke(live, async () => [null, { ok: true }], onSuccess, onFailure);
    expect(onSuccess).toHaveBeenCalledWith({ ok: true });
    expect(onFailure).not.toHaveBeenCalled();
  });

  test("routes a non-null error tuple to failure", async () => {
    const onSuccess = vi.fn();
    const onFailure = vi.fn();
    await runInvoke(live, async () => [new Error("denied"), null], onSuccess, onFailure);
    expect(onFailure).toHaveBeenCalledWith("denied");
    expect(onSuccess).not.toHaveBeenCalled();
  });

  test("stringifies non-Error error tuples", async () => {
    const onFailure = vi.fn();
    await runInvoke(live, async () => ["bad", null], vi.fn(), onFailure);
    // The Either error is normally an object; a bare string falls back to the
    // generic message rather than being interpolated.
    expect(onFailure).toHaveBeenCalledWith("unknown error");
  });

  test("models a thrown work as a failure (not an unhandled rejection)", async () => {
    const onFailure = vi.fn();
    await runInvoke(
      live,
      async () => {
        throw new Error("network down");
      },
      vi.fn(),
      onFailure,
    );
    expect(onFailure).toHaveBeenCalledWith("network down");
  });

  test("ignores the outcome when the signal is already aborted", async () => {
    const aborted = { aborted: true } as AbortSignal;
    const onSuccess = vi.fn();
    const onFailure = vi.fn();
    await runInvoke(aborted, async () => [null, { ok: true }], onSuccess, onFailure);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();
  });
});

describe("onStateChange", () => {
  function fake(initial: string[]) {
    let current = snapshot(initial);
    const listeners: ((s: any) => void)[] = [];
    return {
      snapshot: () => current,
      on: (_e: "change", o: { fn: (s: any) => void }) => {
        listeners.push(o.fn);
        return () => listeners.splice(listeners.indexOf(o.fn), 1);
      },
      emit: (path: string[], error?: unknown) => {
        current = snapshot(path, error);
        for (const l of listeners.slice()) l(current);
      },
      listeners,
    };
  }
  const states = ["idle", "ok", "error"] as const;

  test("fires on a name change with next and prev, not on subscribe", () => {
    const actor = fake(["idle"]);
    const fn = vi.fn();
    onStateChange(actor, states, fn);
    expect(fn).not.toHaveBeenCalled();
    actor.emit(["ok"]);
    expect(fn).toHaveBeenCalledWith("ok", "idle");
  });

  test("does not fire when only the context changed", () => {
    const actor = fake(["ok"]);
    const fn = vi.fn();
    onStateChange(actor, states, fn);
    actor.emit(["ok"]);
    actor.emit(["ok"]);
    expect(fn).not.toHaveBeenCalled();
  });

  test("a dying actor reports error", () => {
    const actor = fake(["ok"]);
    const fn = vi.fn();
    onStateChange(actor, states, fn);
    actor.emit(["__error"], { error: new Error("boom"), reason: "throw" });
    expect(fn).toHaveBeenCalledWith("__error", "ok");
  });

  test("the returned function unsubscribes", () => {
    const actor = fake(["idle"]);
    const fn = vi.fn();
    const off = onStateChange(actor, states, fn);
    off();
    actor.emit(["ok"]);
    expect(fn).not.toHaveBeenCalled();
  });
});
