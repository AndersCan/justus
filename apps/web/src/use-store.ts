import { AsyncDirective, directive } from "lit-html/async-directive.js";
import type { ReadableAtom } from "nanostores";

class UseStoreDirective extends AsyncDirective {
  #unsub: (() => void) | undefined;
  #store: ReadableAtom<unknown> | undefined;
  #select: ((value: unknown) => unknown) | undefined;
  #viewTransition = false;
  #activeTransition: ViewTransition | undefined;
  #pendingUpdate: (() => void) | undefined;
  /** Bumped on every resubscribe. A view transition runs its update a frame
   * later; by then this part may render another store (the router reuses one
   * directive instance across routes), so a stale update must not land. */
  #generation = 0;

  render<Value, Selected>(
    store: ReadableAtom<Value>,
    select: (value: Value) => Selected,
    transitions?: boolean,
  ): Selected {
    if (
      this.#store !== store ||
      this.#select !== select ||
      this.#viewTransition !== (transitions ?? false)
    ) {
      this.#cleanup();
      this.#store = store;
      this.#select = select as ((value: unknown) => unknown) | undefined;
      this.#viewTransition = transitions ?? false;
      if (this.isConnected) this.#subscribe();
    }
    return select(store.get());
  }

  #subscribe(): void {
    const store = this.#store;
    if (!store) return;
    const select = this.#select;
    const generation = this.#generation;
    this.#unsub = store.listen((value) => {
      const update = () => {
        if (generation === this.#generation) this.setValue(select ? select(value) : value);
      };
      this.#runTransition(update);
    });
  }

  #runTransition(update: () => void): void {
    const start =
      typeof document !== "undefined" ? document.startViewTransition.bind(document) : undefined;
    if (!this.#viewTransition || !start) {
      update();
      return;
    }
    if (this.#activeTransition) {
      this.#pendingUpdate = update;
      return;
    }
    let t: ViewTransition;
    try {
      t = start(update);
    } catch {
      update();
      return;
    }
    this.#activeTransition = t;
    void t.updateCallbackDone.catch(() => {});
    void t.ready.catch(() => {});
    t.finished
      .catch(() => {})
      .finally(() => {
        this.#activeTransition = undefined;
        const next = this.#pendingUpdate;
        this.#pendingUpdate = undefined;
        if (next && this.isConnected) {
          this.#runTransition(next);
        }
      });
  }

  #cleanup(): void {
    this.#generation++;
    this.#pendingUpdate = undefined;
    this.#unsub?.();
    this.#unsub = undefined;
  }

  protected override disconnected(): void {
    this.#cleanup();
  }

  protected override reconnected(): void {
    this.#subscribe();
  }
}

const useStoreDirective = directive(UseStoreDirective);

export function useStore<Value, Selected>(
  store: ReadableAtom<Value>,
  select: (value: Value) => Selected,
  transitions?: boolean,
): Selected {
  return useStoreDirective(store, select as (value: unknown) => unknown, transitions) as Selected;
}
