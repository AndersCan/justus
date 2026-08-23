import { describe, expect, test, vi } from "vite-plus/test";
import { atom } from "nanostores";
import { bindStateAtoms, fatalErrorOf, runInvoke, stateNameOf } from "./actor-utils";

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

  test("normalises unknown paths to the error state", () => {
    expect(toName(snapshot(["frobnicate"]))).toBe("error");
    expect(toName(snapshot([]))).toBe("error");
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

describe("bindStateAtoms", () => {
  test("mirrors the snapshot state + fatal flag onto the atoms", () => {
    const $state = atom("idle");
    const $error = atom<string | null>(null);
    const $fatal = atom(false);
    let changeHandler: ((s: any, p: any) => void) | null = null;
    const fakeActor = {
      on: (_event: string, fn: (s: any, p: any) => void) => {
        changeHandler = fn;
      },
      snapshot: () => snapshot(["ok"]),
    };

    bindStateAtoms({
      actor: fakeActor as any,
      states: ["idle", "ok", "error"] as const,
      $state,
      $error,
      $fatal,
    });

    expect(changeHandler).not.toBeNull();
    changeHandler!(snapshot(["error"], { error: new Error("x"), reason: "r" }), snapshot(["ok"]));
    expect($state.get()).toBe("error");
    expect($fatal.get()).toBe(true);
    expect($error.get()).toContain("x");

    changeHandler!(snapshot(["ok"]), snapshot(["error"]));
    expect($state.get()).toBe("ok");
    expect($fatal.get()).toBe(false);
  });
});
