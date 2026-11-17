import { invokeEvent, type EventSpec } from "@ekrooh/bare/core";
import type { SeenRecord } from "./types";

/** Local, never replicated: what this phone has looked at. Both calls are
 * fast file reads or writes. */
const SEEN_TIMEOUT_MS = 5_000;

export const seenSpecs = {
  read: {
    pluginId: "justus.seen",
    name: "seen.read",
    args: {} as Record<string, never>,
    result: {} as { seen: SeenRecord },
  },
  write: {
    pluginId: "justus.seen",
    name: "seen.write",
    args: {} as { seen: SeenRecord },
    result: {} as Record<string, never>,
  },
} as const satisfies Record<string, EventSpec<any, any>>;

export const seenEvents = {
  read() {
    return invokeEvent(seenSpecs.read, {}, null, SEEN_TIMEOUT_MS);
  },
  /** Replaces the whole record. */
  write(seen: SeenRecord) {
    return invokeEvent(seenSpecs.write, { seen }, null, SEEN_TIMEOUT_MS);
  },
};
