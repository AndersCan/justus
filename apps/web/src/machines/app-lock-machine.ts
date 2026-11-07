import { Actor, RealClock, event, state, type Clock } from "@mantaq/core";
import type { LockStatus } from "@justus/core";

/** The Android App lock switch: what the host reports, and whether a change is being saved. */

type AppLockContext = { status: LockStatus | undefined };

/** The host reported the lock status; `undefined` hides the card. */
const statusRead = event("STATUS_READ")<{ status: LockStatus | undefined }>();
/** The switch was tapped and the host is being asked. */
const saveStarted = event("SAVE_STARTED")();
/** The host answered; `status` is what the card shows now. */
const saveEnded = event("SAVE_ENDED")<{ status: LockStatus | undefined }>();

/** The switch can be tapped. */
const idle = state("idle")();
/** The host is being asked; the switch is disabled. */
const saving = state("saving")();

export function createAppLockActor(options: { clock: Clock }) {
  return Actor({
    inputs: [statusRead, saveStarted, saveEnded],
    internal: [],
    outputs: [],
    states: [idle, saving],
    initial: idle,
    clock: options.clock,
    context: { status: undefined } as AppLockContext,
    setup: (m) => {
      /** A fresh status from the host replaces what the card shows, in any state. */
      m.onAny({
        event: statusRead,
        handler: (e, opts) => {
          opts.context.set({ status: e.payload.status });
          return {};
        },
      });
      /** The switch is disabled while the host is asked. */
      m.on(idle, { event: saveStarted, to: [saving], handler: () => ({ state: saving }) });
      /** The host answered: the switch is usable again. */
      m.on(saving, {
        event: saveEnded,
        to: [idle],
        handler: (e, opts) => {
          opts.context.set({ status: e.payload.status });
          return { state: idle };
        },
      });
    },
  });
}

export type AppLockActor = ReturnType<typeof createAppLockActor>;

export const appLockActor = createAppLockActor({ clock: RealClock() });

export const appLockEvents = { statusRead, saveStarted, saveEnded };
