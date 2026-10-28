import {
  resolveCliConfig,
  resolveWorkletConfig,
  type WorkletRuntimeOptions,
} from "@ekrooh/bare/runtime";
import { parseHandoffFd } from "./desktop";

/** Global provided by the Bare runtime (also present in bare-kit worklets). */
declare const Bare: { argv?: string[] } | undefined;

export type JustusRuntimeOptions = WorkletRuntimeOptions & {
  /** Dev mode (`mode=dev`): auth off, fixed port, seeded photos, inbox watcher. */
  dev: boolean;
  /** Dev-only: watched folder; a file dropped here is imported as a photo. */
  inbox?: string;
  /** Hyperswarm DHT bootstrap servers (dev/test: point at a local DHT). */
  bootstrap?: string[];
  /** Desktop host: fd to hand the origin + bootstrap nonce to (not dev). */
  handoffFd?: number;
};

/**
 * Resolves the worklet configuration. On device, the host passes
 * `["<webAssets>", "<storage>", "<cache>"]` as `start(...)` args and the
 * framework's `resolveWorkletConfig()` parses them (auth on, ephemeral port).
 * Under the bare CLI, labeled tokens are parsed by the framework too; dev
 * mode (auth off, port 8080) is chosen only by the explicit `mode=dev` token,
 * plus `origin=` for the Vite dev page. `inbox=` and `bootstrap=` are ours.
 */
export function resolveJustusConfig(): JustusRuntimeOptions {
  const argv = typeof Bare !== "undefined" && Array.isArray(Bare.argv) ? Bare.argv : [];
  // The desktop host launches us with `handoff=<fd>` plus labeled tokens
  // (`auth=on port=0 storage=...`): production semantics, credentials over the
  // pipe instead of `handoff.json`.
  const handoffFd = parseHandoffFd(argv);
  if (handoffFd !== undefined) {
    return { ...resolveCliConfig(argv), handoffFile: false, handoffFd, dev: false };
  }
  const config = resolveWorkletConfig();
  if (config.deviceMode !== false) return { ...config, dev: false };
  const label = (name: string) => {
    const hit = argv.find((a) => a.startsWith(`${name}=`));
    return hit ? hit.slice(name.length + 1) : undefined;
  };
  const bootstrapArg = label("bootstrap");
  return {
    ...config,
    inbox: label("inbox"),
    bootstrap: bootstrapArg ? [bootstrapArg] : undefined,
    dev: true,
  };
}
