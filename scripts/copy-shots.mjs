import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import {
  CORAL,
  assignScreens,
  indexRow,
  parseArgs,
  selectEntries,
  unreachableReason,
} from "./copy-shots-lib.mjs";

/**
 * `pnpm copy:shots [--status draft] [--id <id>] [--assign]`
 *
 * Boots the real stack (scripts/e2e-server.mjs, 3 seeded photos), opens each
 * catalogue entry's `screen` scenario, outlines the `data-copy-id` element in a
 * 2px coral box and saves a 2x screenshot to test-results/copy-shots/<id>.png,
 * plus index.json. Entries no scenario can show are listed as "not reachable"
 * with the reason. `--assign` rewrites every entry's `screen` from what the
 * scenarios actually show.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const enPath = join(root, "apps/web/src/copy/en.json");
const outDir = join(root, "test-results/copy-shots");
const BASE = "http://127.0.0.1:8090";
// No sample album: a phone with an album skips the intro, so the welcome screens live here.
const EMPTY_BASE = "http://127.0.0.1:8091";

/**
 * Each scenario opens a page and returns once it has settled. `fresh` skips the welcome-seen flag
 * and runs on the empty worklet. `at` is the route the page must end on, so a scenario that gets
 * redirected fails instead of saving the wrong screen.
 */
const scenarios = {
  welcome: { fresh: true, at: /\/welcome$/, open: (page) => page.goto("/welcome") },
  "welcome-card-2": { fresh: true, at: /\/welcome$/, open: (page) => welcomeStep(page, 1) },
  "welcome-name": { fresh: true, at: /\/welcome$/, open: (page) => welcomeStep(page, 2) },
  "welcome-start": {
    fresh: true,
    at: /\/welcome$/,
    open: async (page) => {
      await welcomeStep(page, 2);
      await page.getByLabel("Your name").fill("Sam");
      await page.locator("button.ui-btn-primary[type=submit]").click();
      await page.locator('[data-copy-id="welcome.start_sharing"]').waitFor({ timeout: 10_000 });
    },
  },
  "start-album": {
    open: async (page) => {
      await settle(page, "/albums");
      await page
        .getByRole("button", { name: /new album/i })
        .first()
        .click();
      await page.locator('[data-copy-id^="start_album."]').first().waitFor({ timeout: 10_000 });
    },
  },
  gallery: { open: (page) => settle(page, "/", "figure img") },
  lightbox: {
    open: async (page) => {
      await settle(page, "/", "figure img");
      await page.locator("figure img").first().click();
      await page.locator('[data-copy-id^="lightbox."]').first().waitFor({ timeout: 10_000 });
    },
  },
  albums: { open: (page) => settle(page, "/albums") },
  "album-photos": {
    open: async (page) => {
      await settle(page, "/sharing", 'a[href^="/sharing/"]');
      const id = (await page.locator('a[href^="/sharing/"]').first().getAttribute("href")).slice(
        "/sharing/".length,
      );
      await page.goto(`/albums/${id}`);
    },
  },
  sharing: { open: (page) => settle(page, "/sharing", 'a[href^="/sharing/"]') },
  album: {
    open: async (page) => {
      await settle(page, "/sharing", 'a[href^="/sharing/"]');
      await page.locator('a[href^="/sharing/"]').first().click();
      await page.waitForURL(/\/sharing\/.+/);
    },
  },
  devices: { open: (page) => page.goto("/devices") },
  join: { open: (page) => page.goto("/join") },
  "not-found": { at: /\/nope$/, open: (page) => page.goto("/nope") },
  settings: { open: (page) => page.goto("/settings") },
  help: { open: (page) => page.goto("/help") },
};

/** Opens the welcome flow and taps Next `taps` times. */
async function welcomeStep(page, taps) {
  await page.goto("/welcome");
  for (let i = 0; i < taps; i++) {
    const next = page.locator("button.ui-btn-primary[type=button]");
    if ((await next.count()) === 0) throw new Error(`welcome: no primary button at tap ${i + 1}`);
    await next.click({ force: true });
    await page.waitForTimeout(300);
  }
}

async function settle(page, path, ready) {
  await page.goto(path);
  if (ready) await page.locator(ready).first().waitFor({ timeout: 20_000 });
}

const idsOnPage = (page) =>
  page.evaluate(() => [
    ...new Set([...document.querySelectorAll("[data-copy-id]")].map((n) => n.dataset.copyId)),
  ]);

async function startServer() {
  const server = spawn("node", [join(root, "scripts/e2e-server.mjs")], {
    cwd: root,
    stdio: ["ignore", "inherit", "inherit"],
    detached: true,
  });
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const up = await fetch(`${BASE}/index.html`).then(
      (r) => r.ok,
      () => false,
    );
    if (up) return server;
    await new Promise((r) => setTimeout(r, 500));
  }
  process.kill(-server.pid);
  throw new Error("the e2e server did not come up");
}

/** One scenario at a time: the backend serves one page socket. */
async function inScenario(browser, name, work) {
  const { fresh, open, at } = scenarios[name];
  const context = await browser.newContext({
    baseURL: fresh ? EMPTY_BASE : BASE,
    deviceScaleFactor: 2,
    viewport: { width: 420, height: 900 },
    storageState: fresh ? { cookies: [], origins: [] } : join(root, "e2e/welcome-seen.json"),
  });
  try {
    const page = await context.newPage();
    await open(page);
    await page.waitForTimeout(500);
    if (at && !at.test(new URL(page.url()).pathname)) {
      throw new Error(`${name}: ended on ${page.url()}, expected ${at}`);
    }
    return await work(page);
  } finally {
    await context.close();
  }
}

async function shoot(page, entry) {
  const target = page.locator(`[data-copy-id="${entry.id}"]`).first();
  if ((await target.count()) === 0) return { reason: "the element is not on the screen" };
  await target.scrollIntoViewIfNeeded().catch(() => {});
  if (!(await target.isVisible())) return { reason: "the element is on the screen but hidden" };
  const png = join(outDir, `${entry.id}.png`);
  await target.evaluate((el, color) => {
    el.dataset.copyPrev = el.style.outline;
    el.style.outline = `2px solid ${color}`;
    el.style.outlineOffset = "2px";
  }, CORAL);
  await page.screenshot({ path: png });
  await target.evaluate((el) => {
    el.style.outline = el.dataset.copyPrev ?? "";
  });
  return { png };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    console.error(`copy:shots: ${args.error}`);
    process.exit(2);
  }
  const catalogue = JSON.parse(readFileSync(enPath, "utf8"));
  const entries = selectEntries(catalogue, args);
  if (entries.length === 0) {
    console.error("copy:shots: no catalogue entry matches");
    process.exit(2);
  }

  const server = await startServer();
  const browser = await chromium.launch();
  try {
    if (args.assign) {
      const seen = {};
      for (const name of Object.keys(scenarios)) {
        seen[name] = new Set(await inScenario(browser, name, idsOnPage));
      }
      writeFileSync(enPath, `${JSON.stringify(assignScreens(catalogue, seen), null, 2)}\n`);
      console.log("copy:shots: screens assigned in en.json");
      return;
    }

    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    const rows = new Map();
    const byScreen = Map.groupBy(
      entries.filter((e) => e.screen in scenarios),
      (e) => e.screen,
    );
    for (const [name, group] of byScreen) {
      await inScenario(browser, name, async (page) => {
        const shown = new Set(await idsOnPage(page));
        for (const entry of group) {
          const reason = unreachableReason(entry, scenarios, shown.has(entry.id));
          rows.set(entry.id, indexRow(entry, reason ? { reason } : await shoot(page, entry)));
        }
      });
    }
    const index = entries.map(
      (e) => rows.get(e.id) ?? indexRow(e, { reason: unreachableReason(e, scenarios, false) }),
    );
    writeFileSync(join(outDir, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
    const shot = index.filter((r) => r.png !== "not reachable").length;
    console.log(`copy:shots: ${shot} shots, ${index.length - shot} not reachable → ${outDir}`);
  } finally {
    await browser.close();
    process.kill(-server.pid);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
