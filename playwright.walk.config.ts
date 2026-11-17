import { defineConfig } from "@playwright/test";

/**
 * The release walk (e2e/device/release-walk.walk.ts): Ada in Chromium on a worklet that joins the
 * public DHT, Ben on the emulator. Run by `JUSTUS_WALK=1 bash scripts/maestro-e2e.sh`, which sets
 * JUSTUS_WALK_SERIAL and JUSTUS_WALK_OUT. No retries: a red walk is fixed at its cause.
 */
export default defineConfig({
  testDir: "./e2e/device",
  testMatch: "*.walk.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list", { printSteps: true }]],
  timeout: 15 * 60_000,
  outputDir: ".maestro/out/walk/test-results",
  use: {
    baseURL: "http://127.0.0.1:8091",
    browserName: "chromium",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node scripts/e2e-server.mjs",
    url: "http://127.0.0.1:8091/index.html",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
