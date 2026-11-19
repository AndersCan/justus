import { defineConfig } from "@playwright/test";

/**
 * The update walk (e2e/device/update-walk.update.ts): Ben's emulator has the last release with Ada's
 * album, then this build installs over it. Ada runs the last release's own server, which the walk
 * starts itself. Run by `JUSTUS_WALK=1 bash scripts/maestro-e2e.sh` after the release walk, which sets
 * JUSTUS_WALK_SERIAL, JUSTUS_WALK_OUT, JUSTUS_WALK_APK, JUSTUS_WALK_ADB and JUSTUS_WALK_FROM(_TAG).
 * No retries: a red walk is fixed at its cause.
 */
export default defineConfig({
  testDir: "./e2e/device",
  testMatch: "*.update.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list", { printSteps: true }]],
  timeout: 15 * 60_000,
  outputDir: ".maestro/out/walk-update/test-results",
  use: {
    baseURL: "http://127.0.0.1:8091",
    browserName: "chromium",
    trace: "retain-on-failure",
  },
});
