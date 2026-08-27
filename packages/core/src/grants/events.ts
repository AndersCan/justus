import { invokeEvent, type EventSpec, type InvokeEnvelope } from "@ekrooh/bare/core";
import type { GrantRecord } from "./types";

/** Backend surface for the per-device grant ledger (issue #30). The ledger is
 * never replicated, so this is strictly the local owner's view of who holds
 * their album and who to prompt about. `view` returns the full record list plus
 * the peer ids whose unknown-holder prompt is currently due (once daily). */
export const grantSpecs = {
  view: {
    pluginId: "justus.grants",
    name: "grants.view",
    args: {} as Record<string, never>,
    result: {} as { records: GrantRecord[]; due: string[] },
  },
  grant: {
    pluginId: "justus.grants",
    name: "grants.grant",
    args: {} as { peerId: string },
    result: {} as { record: GrantRecord },
  },
  decline: {
    pluginId: "justus.grants",
    name: "grants.decline",
    args: {} as { peerId: string },
    result: {} as { record: GrantRecord },
  },
  revoke: {
    pluginId: "justus.grants",
    name: "grants.revoke",
    args: {} as { peerId: string },
    result: {} as { record: GrantRecord },
  },
  snooze: {
    pluginId: "justus.grants",
    name: "grants.snooze",
    // "Not now" on the batched prompt card: dismisses every due peer for today.
    args: {} as Record<string, never>,
    result: {} as { snoozed: number },
  },
} as const satisfies Record<string, EventSpec<any, any>>;

export const grantEvents = {
  view(): InvokeEnvelope<
    "grants.view",
    Record<string, never>,
    { records: GrantRecord[]; due: string[] }
  > {
    return invokeEvent(grantSpecs.view, {}, null, 10_000);
  },
  grant(
    peerId: string,
  ): InvokeEnvelope<"grants.grant", { peerId: string }, { record: GrantRecord }> {
    return invokeEvent(grantSpecs.grant, { peerId }, null, 10_000);
  },
  decline(
    peerId: string,
  ): InvokeEnvelope<"grants.decline", { peerId: string }, { record: GrantRecord }> {
    return invokeEvent(grantSpecs.decline, { peerId }, null, 10_000);
  },
  snooze(): InvokeEnvelope<"grants.snooze", Record<string, never>, { snoozed: number }> {
    return invokeEvent(grantSpecs.snooze, {}, null, 10_000);
  },
  revoke(
    peerId: string,
  ): InvokeEnvelope<"grants.revoke", { peerId: string }, { record: GrantRecord }> {
    return invokeEvent(grantSpecs.revoke, { peerId }, null, 10_000);
  },
};
