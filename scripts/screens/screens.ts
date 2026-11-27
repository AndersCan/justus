import { dirname, join, resolve } from "node:path";
import { isScreenFileName, screenFileName, themesFor } from "./screen-file-name.ts";
import { left, right, wrap } from "./either.ts";
import { mkdirSync, openSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { parseScreensArguments, screensUsage } from "./parse-screens-arguments.ts";
import { spawn, spawnSync } from "node:child_process";
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
const serverReadyLine = "[justus:e2e] worklet up on";
const stillPage = { quietMilliseconds: 1000, limitMilliseconds: 10_000 };

interface ShotOptions {
  folder: string;
  position: number;
  theme: Theme;
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
  if (parsed.value.command === "help") {
    console.log(screensUsage);
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
 * error exit, Ctrl-C and a closed terminal all pass through `exit`, during boot too.
 */
function stopServerOnExit(server: ChildProcess): void {
  process.once("exit", () => stopServer(server));
  process.once("SIGINT", () => process.exit(130));
  process.once("SIGTERM", () => process.exit(143));
  process.once("SIGHUP", () => process.exit(129));
}

async function walkScreens(browser: Browser, options: WalkOptions): Promise<WalkResult> {
  const result: WalkResult = { folder: options.folder, saved: [], failed: [] };
  const themes = themesFor(options.themeChoice);
  for (const [index, screen] of screenWalk.entries()) {
    for (const theme of themes) {
      const shotOptions = { folder: options.folder, position: index + 1, theme };
      const fileName = screenFileName(screen.name, shotOptions);
      const shot = await wrap(shootScreen(browser, { screen, shot: shotOptions, fileName }));
      const failure = shot.ok ? shot.value : String(shot.error);
      if (failure === undefined) result.saved.push(fileName);
      else result.failed.push(`${fileName}: ${failure}`);
    }
  }
  return result;
}

/** Why a screen has no shot, whether a step failed or something threw; undefined when it saved. */
function failureOf(shot: Either<unknown, Either<string, void>>): string | undefined {
  if (!shot.ok) return String(shot.error);
  if (!shot.value.ok) return shot.value.error;
  return undefined;
}

interface ShootRequest {
  screen: Screen;
  shot: ShotOptions;
  fileName: string;
}

/** One screen at a time: the worklet serves one page socket, so a second open page would steal it. */
async function shootScreen(browser: Browser, request: ShootRequest): Promise<string | undefined> {
  const { screen, shot, fileName } = request;
  const context = await browser.newContext({
    baseURL: originFor(screen),
    viewport: phoneViewport,
    deviceScaleFactor: 2,
    colorScheme: shot.theme,
    storageState: storageFor(screen),
  });
  context.setDefaultTimeout(stepMilliseconds);
  const page = await context.newPage();
  const opened = await wrap(screen.open(page));
  const saved = await wrap(saveShot(page, { opened, screen, file: join(shot.folder, fileName) }));
  await context.close();
  return failureOf(saved);
}

interface SaveShotOptions {
  opened: Either<unknown, void>;
  screen: Screen;
  file: string;
}

async function saveShot(page: Page, options: SaveShotOptions): Promise<Either<string, void>> {
  if (!options.opened.ok) return left(String(options.opened.error));
  await waitForStillPage(page);
  await growToContent(page);
  const path = new URL(page.url()).pathname;
  if (!options.screen.endsOn.test(path)) {
    return left(`ended on ${path}, expected ${String(options.screen.endsOn)}`);
  }
  const taken = await wrap(page.screenshot({ path: options.file, animations: "disabled" }));
  if (!taken.ok) return left(String(taken.error));
  return right(undefined);
}

/**
 * Waits until nothing on the page has changed for a second, at most ten. Data from the worklet keeps
 * arriving after a screen's own step is done, such as the profile name on Settings.
 */
async function waitForStillPage(page: Page): Promise<void> {
  await page.evaluate(untilStill, stillPage);
}

function untilStill(options: typeof stillPage): Promise<void> {
  return new Promise((settle) => {
    const observer = new MutationObserver(() => restartQuietTimer());
    let quietTimer = setTimeout(finish, options.quietMilliseconds);
    const limitTimer = setTimeout(finish, options.limitMilliseconds);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    function restartQuietTimer(): void {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(finish, options.quietMilliseconds);
    }
    function finish(): void {
      observer.disconnect();
      clearTimeout(quietTimer);
      clearTimeout(limitTimer);
      settle();
    }
  });
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
  switch (screen.phone) {
    case "new":
      return { cookies: [], origins: [] };
    case "seeded":
      return join(root, "e2e/welcome-seen.json");
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
  stopServerOnExit(server);
  const deadline = Date.now() + serverBootMilliseconds;
  while (Date.now() < deadline) {
    const bootLog = readFileSync(logPath, "utf8");
    if (bootLog.includes(serverReadyLine)) return right(server);
    if (hasExited(server)) return left(bootFailure(bootLog));
    await sleep(500);
  }
  stopServer(server);
  return left("the e2e server did not come up");
}

/** The server's own last error line, which names the cause, such as a port in use. */
function bootFailure(bootLog: string): string {
  const errorLine = bootLog.split("\n").findLast((line) => line.includes("ERROR"));
  return errorLine ?? "the e2e server stopped while it booted";
}

/**
 * Signals the whole process group, even when the e2e server itself has exited: on some failures it
 * exits and leaves a worklet behind. `kill` reports a group that is already gone instead of throwing.
 */
function stopServer(server: ChildProcess): void {
  if (server.pid === undefined) return;
  const group = `-${server.pid}`;
  spawnSync("kill", ["-TERM", "--", group], { stdio: "ignore" });
}

function hasExited(server: ChildProcess): boolean {
  return server.exitCode !== null || server.signalCode !== null;
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
