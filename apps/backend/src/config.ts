import fs from "bare-fs";
import { resolveWorkletConfig, type WorkletRuntimeOptions } from "@ekrooh/bare/runtime";

/** Global provided by the Bare runtime (also present in bare-kit worklets). */
declare const Bare: { argv?: string[] } | undefined;

export type JustusRuntimeOptions = WorkletRuntimeOptions & {
  /** Dev mode (bare CLI): auth off, fixed port, seeded photos, inbox watcher. */
  dev: boolean;
  /** Dev-only: watched folder; a file dropped here is imported as a photo. */
  inbox?: string;
  /** Hyperswarm DHT bootstrap servers (dev/test: point at a local DHT). */
  bootstrap?: string[];
};

function isDirectory(p: unknown): boolean {
  if (typeof p !== "string") return false;
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolves the worklet configuration. On device, the host passes
 * `["<webAssets>", "<storage>", "<cache>"]` as `start(...)` args and the
 * framework's `resolveWorkletConfig()` parses them (auth on, ephemeral port).
 * Under the bare CLI (dev), `Bare.argv` is `[binary, script, ...args]` so we
 * scan for directories and force auth off + port 8080 (the framework cannot
 * produce that combination itself — it derives `deviceMode` from storage).
 */
export function resolveJustusConfig(): JustusRuntimeOptions {
  const device = resolveWorkletConfig();
  if (device.storage) {
    return { ...device, dev: false };
  }
  const argv = typeof Bare !== "undefined" && Array.isArray(Bare.argv) ? Bare.argv : [];
  const dirs = argv.filter(isDirectory);
  const portArg = argv.find((a) => /^\d{4,5}$/.test(a));
  const port = portArg ? Number(portArg) : 8080;
  const bootstrapArg = argv.find((a) => a.startsWith("bootstrap:"));
  const bootstrap = bootstrapArg ? [bootstrapArg.slice("bootstrap:".length)] : undefined;
  return {
    storage: dirs[0],
    cache: dirs[1],
    inbox: dirs[2],
    auth: false,
    port,
    bootstrap,
    dev: true,
  };
}
