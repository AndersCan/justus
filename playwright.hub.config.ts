import { defineConfig } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * E2e against the MULTI-INSTANCE hub (issue #18 — "each browser tab is its own
 * bare instance"). Unlike the single-instance `playwright.config.ts`, this
 * config boots a local DHT + N worklets via `globalSetup` and gives each test a
 * set of pages, one per instance, so p2p sync between distinct bare instances
 * can be asserted.
 *
 * The hub harness (`scripts/e2e-hub.mjs`) requires the bare build + Playwright
 * browsers + peers, so this config is run on demand via `npm run test:e2e-p2p`,
 * not by the fast `vp` checks.
 */
const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: "./e2e/p2p",
  // Each run boots a fresh hub; instances are stateful and order matters.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  globalSetup: resolve(here, "e2e/hub/global-setup.mjs"),
  globalTeardown: resolve(here, "e2e/hub/global-teardown.mjs"),
  use: {
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
