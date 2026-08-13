import { build } from "esbuild";

/** Packages that must resolve at runtime from node_modules under the Bare
 * runtime: the framework, the p2p stack (+ native addons), and the bare-*
 * builtins. `@justus/core` and all local source get bundled. */
export const workletExternal = [
  "@ekrooh/bare",
  "corestore",
  "hyperdrive",
  "hyperswarm",
  "bare-crypto",
  "bare-encoding",
  "bare-fs",
  "bare-path",
];

export const workletEntry = "src/main.core.ts";
export const workletOutfile = "dist/main.core.gen.js";

export function workletBuildOptions(entry = workletEntry, outfile = workletOutfile) {
  return {
    entryPoints: [entry],
    outfile,
    bundle: true,
    external: workletExternal,
    platform: "node",
    format: "esm",
    logLevel: "info",
  };
}

await build(workletBuildOptions());
