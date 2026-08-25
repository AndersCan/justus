/**
 * Cross-instance e2e for the justus multi-instance hub (issue #18).
 *
 * Requires the hub to be live — `playwright.hub.config.ts` boots it via
 * `globalSetup` (one DHT + N distinct bare worklets). Run with:
 *
 *   npm run test:e2e-p2p
 *
 * The default `playwright.config.ts` ignores the e2e/p2p directory, so this
 * spec is excluded from the single-instance run.
 */

import { expect, test, resolveInstance } from "../hub/fixtures.mjs";

test("every instance serves its own distinct bare app shell", async ({
  instancePages,
  hubRegistry,
}) => {
  expect(hubRegistry.instances.length).toBeGreaterThanOrEqual(2);

  for (const page of instancePages) {
    await page.goto("/index.html");
    // The built web app loads on its own loopback origin, proving the worklet
    // is up and serving the app for this distinct bare instance.
    await expect(page).toHaveTitle(/justus/i, { timeout: 20_000 });
  }

  // Sanity: the two instances are genuinely different origins (distinct ports).
  const a = resolveInstance(hubRegistry, 0);
  const b = resolveInstance(hubRegistry, 1);
  expect(a.url).not.toEqual(b.url);
  expect(a.port).not.toEqual(b.port);
});
