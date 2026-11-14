/**
 * Playwright fixtures for the justus multi-instance e2e hub (issue #18).
 *
 * Reads the registry `scripts/e2e-hub.mjs` wrote and hands each test a view of
 * the running hub: the parsed registry, the per-instance descriptors, and a set
 * of one browser page per instance (so a test can drive two tabs that are
 * genuinely distinct bare instances and assert p2p sync between them).
 *
 * The hub must already be up — `playwright.hub.config.ts` boots it via
 * `globalSetup` (and tears it down via `globalTeardown`). `loadRegistry()` throws
 * a clear error if you forget.
 */

import { test as base, expect } from "@playwright/test";
import { loadRegistry, resolveInstance } from "./registry-reader.mjs";

export const test = base.extend({
  /** Parsed + validated hub registry (dht + instances). Loaded per test. */
  // eslint-disable-next-line no-empty-pattern — Playwright passes the (unused) fixture context first.
  hubRegistry: async ({}, use) => {
    await use(loadRegistry());
  },

  /** Convenience alias: the registry's instance descriptors. */
  instances: async ({ hubRegistry }, use) => {
    await use(hubRegistry.instances);
  },

  /**
   * One browser page per running instance, each bound to that instance's
   * loopback URL. Close all contexts in `finally` so instances don't leak
   * across tests. Use for cross-instance / p2p sync assertions.
   */
  instancePages: async ({ browser, hubRegistry }, use, testInfo) => {
    /** @type {import('@playwright/test').BrowserContext[]} */
    const contexts = [];
    /** @type {import('@playwright/test').Page[]} */
    const pages = [];
    try {
      for (const inst of hubRegistry.instances) {
        const ctx = await browser.newContext({ baseURL: inst.url });
        const page = await ctx.newPage();
        contexts.push(ctx);
        pages.push(page);
      }
      await use(pages);
      // A failed run attaches each instance's live p2p state and logs, so the
      // failure can be diagnosed headless from the report alone (#200).
      if (testInfo.status !== testInfo.expectedStatus) {
        for (const [i, page] of pages.entries()) {
          for (const route of ["/__state", "/__logs"]) {
            // A phone the test never opened sits on about:blank, where a relative
            // fetch has no origin; ask the instance from the context instead.
            const url = new URL(route, hubRegistry.instances[i].url).href;
            const body = await page
              .context()
              .request.get(url)
              .then((res) => res.text())
              .catch((e) => `fetch ${route} failed: ${e}`);
            await testInfo.attach(`instance-${i + 1}${route.replace("/", "-")}.json`, {
              body,
              contentType: "application/json",
            });
            if (route === "/__state") console.log(`instance-${i + 1} ${route}: ${body}`);
          }
        }
      }
    } finally {
      await Promise.all(contexts.map((c) => c.close().catch(() => {})));
    }
  },
});

export { expect, resolveInstance };
