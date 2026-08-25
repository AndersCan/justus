import { CoreError, definePlugin, type PluginContext } from "@ekrooh/bare/core";
import { logSpecs } from "@justus/core";
import type { LogCollector } from "./log-collector";

/** The collector surface the plugin needs (kept narrow so tests can stub it). */
export type LogCollectorLike = Pick<LogCollector, "view" | "clear">;

function errResult(error: unknown): [CoreError, null] {
  const message = error instanceof Error ? error.message : String(error);
  return [new CoreError("PLUGIN_ERROR", message), null];
}

/** The `justus.logs` plugin — the framed-socket surface the web Logs page polls. */
export function createLogsPlugin(deps: { collector: LogCollectorLike }) {
  return definePlugin("justus.logs", logSpecs, {
    capabilities: ["logs"],
    invoke: {
      view: async (args) => {
        try {
          const entries = deps.collector.view({
            ...(typeof args.tail === "number" ? { tail: args.tail } : {}),
            ...(typeof args.level === "string" ? { level: args.level as never } : {}),
            ...(Array.isArray(args.sources) ? { sources: args.sources } : {}),
          });
          return [null, { entries }];
        } catch (e) {
          return errResult(e);
        }
      },
      clear: async () => {
        try {
          const cleared = deps.collector.clear();
          return [null, { cleared }];
        } catch (e) {
          return errResult(e);
        }
      },
    },
  });
}
