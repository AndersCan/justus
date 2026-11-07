import { invokeEvent, type EventSpec, type InvokeEnvelope } from "@ekrooh/bare/core";

export type LockStatus = { available: boolean; enabled: boolean };

/** The unlock prompt waits on the user, as pickers do. */
const LOCK_PROMPT_TIMEOUT_MS = 300_000;
/** `status` is local and fast; a host without the plugin must not leave the card hanging. */
const LOCK_STATUS_TIMEOUT_MS = 5_000;

/**
 * `justus.lock` — host-only app lock. The worklet registers a stub (no
 * handlers) so the router delegates the invoke to the native host.
 */
export const lockSpecs = {
  status: {
    pluginId: "justus.lock",
    name: "lock.status",
    args: {} as Record<string, never>,
    result: {} as LockStatus,
  },
  setEnabled: {
    pluginId: "justus.lock",
    name: "lock.setEnabled",
    args: {} as { enabled: boolean },
    result: {} as { enabled: boolean },
  },
} as const satisfies Record<string, EventSpec<any, any>>;

export const justusLockEvents = {
  lock: {
    status(): InvokeEnvelope<"lock.status", Record<string, never>, LockStatus> {
      return invokeEvent(lockSpecs.status, {}, null, LOCK_STATUS_TIMEOUT_MS);
    },
    setEnabled(
      enabled: boolean,
    ): InvokeEnvelope<"lock.setEnabled", { enabled: boolean }, { enabled: boolean }> {
      return invokeEvent(lockSpecs.setEnabled, { enabled }, null, LOCK_PROMPT_TIMEOUT_MS);
    },
  },
};
