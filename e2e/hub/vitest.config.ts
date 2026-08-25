import { defineConfig } from "vite-plus";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Scoped vitest config for the multi-instance e2e hub core (issue #18).
 * Runs only the hub's pure, network-free unit suite. Deliberately NOT picked
 * up by the fast `vp check` / `vp run -r test` (the e2e dir is not a package),
 * matching the issue's "excluded from fast vp check" acceptance criterion.
 */
export default defineConfig({
  root: here,
  test: {
    environment: "node",
    include: ["*.test.mjs"],
    // vitest's default exclude drops `**/e2e/**`; re-declare without it so the
    // hub suite is discoverable from this scoped config.
    exclude: ["**/node_modules/**", "**/.git/**"],
  },
});
