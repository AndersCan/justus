import { defineConfig } from "@playwright/test";

/**
 * E2e against the REAL stack: `scripts/e2e-server.mjs` boots the Bare worklet
 * (fresh storage → 3 seeded photos) serving the built web app same-origin on
 * 127.0.0.1:8080 — the same flow a device runs.
 */
export default defineConfig({
  testDir: "./e2e",
  /**
   * The multi-instance hub specs live under e2e/p2p and are driven by their own
   * config (playwright.hub.config.ts) — keep them out of the single-instance run.
   * The e2e/hub unit tests are vitest specs (run via `test:e2e-hub`), not Playwright
   * specs, so they must be excluded here too or Playwright collects and fails on them.
   */
  testIgnore: ["**/p2p/**", "**/hub/**"],
  // Tests share ONE stateful worklet (fresh per run, but order matters) —
  // run serially and keep assertions order-independent.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:8080",
    trace: "retain-on-failure",
    // The first-run welcome screen is suppressed in e2e so specs that load "/"
    // land on the gallery/settings/sharing surfaces they assert.
    storageState: "e2e/welcome-seen.json",
  },
  webServer: {
    command: "node scripts/e2e-server.mjs",
    url: "http://127.0.0.1:8080/index.html",
    reuseExistingServer: false,
    timeout: 90_000,
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
