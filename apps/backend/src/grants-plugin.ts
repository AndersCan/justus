import { CoreError, definePlugin } from "@ekrooh/bare/core";
import { grantSpecs } from "@justus/core";
import type { GrantLedger } from "./grant-ledger";

/** The ledger surface the plugin needs (kept narrow so tests stub it). */
export type GrantLedgerLike = Pick<
  GrantLedger,
  "list" | "dueUnknownHolderPrompts" | "grant" | "decline" | "revoke" | "snoozeUnknownHolderPrompts"
>;

function errResult(error: unknown): [CoreError, null] {
  const message = error instanceof Error ? error.message : String(error);
  return [new CoreError("PLUGIN_ERROR", message), null];
}

/** The `justus.grants` plugin — the framed-socket surface the web Sharing view
 * polls. Read-only `view` plus the three user actions on the unknown-holder
 * prompt (grant / decline / snooze). Mirrors the `justus.logs` plugin shape. */
export function createGrantsPlugin(deps: { ledger: GrantLedgerLike }) {
  return definePlugin("justus.grants", grantSpecs, {
    capabilities: ["grants"],
    invoke: {
      view: async () => {
        try {
          const records = deps.ledger.list();
          const due = deps.ledger.dueUnknownHolderPrompts(Date.now()).map((r) => r.peerId);
          return [null, { records, due }];
        } catch (e) {
          return errResult(e);
        }
      },
      grant: async (args) => {
        try {
          const record = await deps.ledger.grant(args.peerId);
          return [null, { record }];
        } catch (e) {
          return errResult(e);
        }
      },
      decline: async (args) => {
        try {
          const record = await deps.ledger.decline(args.peerId);
          return [null, { record }];
        } catch (e) {
          return errResult(e);
        }
      },
      revoke: async (args) => {
        try {
          const record = await deps.ledger.revoke(args.peerId);
          return [null, { record }];
        } catch (e) {
          return errResult(e);
        }
      },
      snooze: async () => {
        try {
          const due = deps.ledger.dueUnknownHolderPrompts(Date.now()).length;
          await deps.ledger.snoozeUnknownHolderPrompts(Date.now());
          return [null, { snoozed: due }];
        } catch (e) {
          return errResult(e);
        }
      },
    },
  });
}
