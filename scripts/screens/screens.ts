import { dirname, join, resolve } from "node:path";
import { isScreenFileName, screenFileName, themesFor } from "./screen-file-name.ts";
import { left, right, wrap } from "./either.ts";
import { mkdirSync, openSync, readdirSync, rmSync } from "node:fs";
import { parseScreensArguments, screensUsage } from "./parse-screens-arguments.ts";
import type { Theme, ThemeChoice } from "./screen-file-name.ts";
import type { Browser } from "@playwright/test";
import type { ChildProcess } from "node:child_process";
import { chromium } from "@playwright/test";
import type { Either } from "./either.ts";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import type { Screen } from "./screen-walk.ts";
import { screenWalk } from "./screen-walk.ts";
import { setTimeout as sleep } from "node:timers/promises";
import { spawn } from "node:child_process";

/**
 * `pnpm screens [--out <folder>] [--theme light|dark|both]` boots the real stack
 * (scripts/e2e-server.mjs), walks every screen in `screenWalk` on a phone-sized page and saves one
 * PNG per screen, named in walk order, for a reviewer that reads only the images.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const seededOrigin = "http://127.0.0.1:8090";
const newPhoneOrigin = "http://127.0.0.1:8091";
const serverBootMilliseconds = 300_000;
const stepMilliseconds = 15_000;
const phoneViewport = { width: 390, height: 844 };

interface ShotOptions {
  folder: string;
  position: number;
  theme: Theme;
  themeChoice: ThemeChoice;
}

interface WalkOptions {
  folder: string;
  themeChoice: ThemeChoice;
}

interface WalkResult {
  folder: string;
  saved: string[];
  failed: string[];
}

async function main(): Promise<void> {
  const parsed = parseScreensArguments(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(`screens: ${parsed.error}\n${screensUsage}`);
    process.exitCode = 2;
    return;
  }
  const folder = resolve(parsed.value.out ?? join(root, "test-results/screens"));
  mkdirSync(folder, { recursive: true });
  removeOldShots(folder);
  const logPath = join(root, "test-results/screens-server.log");
  const server = await startServer(logPath);
  if (!server.ok) {
    console.error(`screens: ${server.error}, see ${logPath}`);
    process.exitCode = 1;
    return;
  }
  stopServerOnExit(server.value);
  const browser = await chromium.launch();
  const result = await walkScreens(browser, { folder, themeChoice: parsed.value.themeChoice });
  await browser.close();
  stopServer(server.value);
  report(result);
}

/** Deletes only the PNGs an earlier run wrote, so `--out` can never wipe a folder that holds anything else. */
function removeOldShots(folder: string): void {
  const oldShots = readdirSync(folder).filter((name) => isScreenFileName(name));
  for (const name of oldShots) rmSync(join(folder, name));
}

/**
 * The server runs in its own process group, so it outlives this script unless stopped. A crash, an
 * error exit and Ctrl-C all pass through `exit`.
 */
function stopServerOnExit(server: ChildProcess): void {
  process.once("exit", () => stopServer(server));
  process.once("SIGINT", () => process.exit(130));
  process.once("SIGTERM", () => process.exit(143));
}

async function walkScreens(browser: Browser, options: WalkOptions): Promise<WalkResult> {
  const result: WalkResult = { folder: options.folder, saved: [], failed: [] };
  const themes = themesFor(options.themeChoice);
  for (const [index, screen] of screenWalk.entries()) {
    for (const theme of themes) {
      const shotOptions = { ...options, position: index + 1, theme };
      const shot = await shootScreen(browser, { screen, shot: shotOptions });
      if (shot.ok) result.saved.push(shot.value);
      else result.failed.push(shot.error);
    }
  }
  return result;
}

interface ShootRequest {
  screen: Screen;
  shot: ShotOptions;
}

/** One screen at a time: the worklet serves one page socket, so a second open page would steal it. */
async function shootScreen(
  browser: Browser,
  request: ShootRequest,
): Promise<Either<string, string>> {
  const { screen, shot } = request;
  const context = await browser.newContext({
    baseURL: originFor(screen),
    viewport: phoneViewport,
    deviceScaleFactor: 2,
    colorScheme: shot.theme,
    storageState: storageFor(screen),
  });
  context.setDefaultTimeout(stepMilliseconds);
  const page = await context.newPage();
  const fileName = screenFileName(screen.name, shot);
  const opened = await wrap(screen.open(page));
  const path = new URL(page.url()).pathname;
  const saved = await saveShot(page, { opened, path, screen, file: join(shot.folder, fileName) });
  await context.close();
  if (!saved.ok) return left(`${fileName}: ${saved.error}`);
  return right(fileName);
}

interface SaveShotOptions {
  opened: Either<unknown, void>;
  path: string;
  screen: Screen;
  file: string;
}

async function saveShot(page: Page, options: SaveShotOptions): Promise<Either<string, void>> {
  if (!options.opened.ok) return left(String(options.opened.error));
  if (!options.screen.endsOn.test(options.path)) {
    return left(`ended on ${options.path}, expected ${String(options.screen.endsOn)}`);
  }
  await growToContent(page);
  const taken = await wrap(page.screenshot({ path: options.file, animations: "disabled" }));
  if (!taken.ok) return left(String(taken.error));
  return right(undefined);
}

/**
 * A tall page is shot as one image on a phone stretched to the page's height. A full-page shot
 * would leave the fixed tab bar mid-image, over the content, where no phone shows it.
 */
async function growToContent(page: Page): Promise<void> {
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  if (height > phoneViewport.height) await page.setViewportSize({ ...phoneViewport, height });
}

function originFor(screen: Screen): string {
  switch (screen.phone) {
    case "new":
      return newPhoneOrigin;
    case "seeded":
      return seededOrigin;
    default:
      return isNever(screen.phone);
  }
}

function storageFor(screen: Screen) {
  const welcomeSeen = { name: "justus:welcome-seen", value: "1" };
  switch (screen.phone) {
    case "new":
      return { cookies: [], origins: [] };
    case "seeded":
      return { cookies: [], origins: [{ origin: seededOrigin, localStorage: [welcomeSeen] }] };
    default:
      return isNever(screen.phone);
  }
}

async function startServer(logPath: string): Promise<Either<string, ChildProcess>> {
  mkdirSync(dirname(logPath), { recursive: true });
  const log = openSync(logPath, "w");
  const server = spawn("node", [join(root, "scripts/e2e-server.mjs")], {
    cwd: root,
    stdio: ["ignore", log, log],
    detached: true,
  });
  const deadline = Date.now() + serverBootMilliseconds;
  while (Date.now() < deadline) {
    if (await isUp(`${seededOrigin}/index.html`)) return right(server);
    if (server.exitCode !== null) return left("the e2e server stopped while it booted");
    await sleep(500);
  }
  stopServer(server);
  return left("the e2e server did not come up");
}

async function isUp(url: string): Promise<boolean> {
  const response = await wrap(fetch(url));
  return response.ok && response.value.ok;
}

function stopServer(server: ChildProcess): void {
  const running = server.exitCode === null && server.signalCode === null;
  if (running && server.pid !== undefined) process.kill(-server.pid, "SIGTERM");
}

function report(result: WalkResult): void {
  for (const failure of result.failed) console.error(`screens: could not shoot ${failure}`);
  const count = result.saved.length;
  console.log(`screens: ${count} screenshots in ${result.folder}`);
  if (result.failed.length > 0) process.exitCode = 1;
}

function isNever(value: never): never {
  throw new Error(`unexpected phone ${String(value)}`);
}

await main();
