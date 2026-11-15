#!/usr/bin/env node
// Walks .maestro/flows/first-run.yaml on an iPhone Simulator (up to the share menu), or with
// --ipad .maestro/ios/ipad-share.yaml on an iPad Simulator, or with --invite
// .maestro/ios/invite-page.yaml (Safari, the invite page, then the app). Builds the Debug app, boots the
// first available Simulator, installs, and runs Maestro.
// CI glue for .github/workflows/ios-device.yml; the green run is its test.
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ipad = process.argv.includes("--ipad");
const invite = process.argv.includes("--invite");
const flow = ipad
  ? ".maestro/ios/ipad-share.yaml"
  : invite
    ? ".maestro/ios/invite-page.yaml"
    : ".maestro/flows/first-run.yaml";
const derived = path.join(root, "apps/ios/build/dd");
const app = path.join(derived, "Build/Products/Debug-iphonesimulator/Justus.app");
const out = path.join(root, ".maestro/out");
const bundleId = "no.cankode.justus";
const driverId = "dev.mobile.maestro-driver-iosUITests.xctrunner";
const startedAt = Date.now();

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  return spawnSync(command, args, { cwd: root, stdio: "inherit", ...options });
}

function capture(command, args) {
  return spawnSync(command, args, { cwd: root, encoding: "utf8" });
}

if (capture("which", ["maestro"]).status !== 0) {
  fail("maestro not on PATH: install Maestro 2.12.1");
}

// The newest iOS runtime's first available iPhone (or iPad with --ipad), an already booted one
// first. iPhone SE models have Touch ID, not Face ID.
function pickSimulator() {
  const list = JSON.parse(
    capture("xcrun", ["simctl", "list", "devices", "available", "-j"]).stdout,
  );
  const runtimes = Object.keys(list.devices)
    .filter((name) => name.includes("SimRuntime.iOS-"))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const runtime of runtimes) {
    const matches = list.devices[runtime].filter((device) =>
      ipad
        ? device.name.startsWith("iPad")
        : device.name.startsWith("iPhone") && !device.name.includes("SE"),
    );
    const booted = matches.find((device) => device.state === "Booted");
    const chosen = booted ?? matches[0];
    if (chosen) return chosen;
  }
  return null;
}

const device = pickSimulator();
if (!device) fail(`no ${ipad ? "iPad" : "iPhone"} Simulator: install an iOS runtime`);
const { udid, name } = device;
console.log(`Simulator: ${name} (${udid})`);

{
  if (run("node", ["apps/ios/scripts/build-ios.mjs"]).status !== 0) fail("build-ios.mjs failed");
  let resolved = false;
  for (let attempt = 1; attempt <= 4 && !resolved; attempt++) {
    const project = ["-project", "apps/ios/justus.xcodeproj", "-scheme", "justus"];
    resolved =
      run("xcodebuild", ["-resolvePackageDependencies", ...project, "-derivedDataPath", derived])
        .status === 0;
    // Backoff between package download attempts.
    if (!resolved) spawnSync("sleep", [String(attempt * 15)]);
  }
  if (!resolved) fail("Swift package resolution failed");
  const build = run("xcodebuild", [
    "build",
    "-project",
    "apps/ios/justus.xcodeproj",
    "-scheme",
    "justus",
    "-destination",
    `id=${udid}`,
    "-derivedDataPath",
    derived,
    "CODE_SIGNING_ALLOWED=NO",
  ]);
  if (build.status !== 0) fail("xcodebuild failed");
  // The build leaves its daemons resident; on the 7 GB runner they starve the Simulator and Maestro's first launch hangs.
  for (const daemon of ["XCBBuildService", "SWBBuildService", "swift-build"])
    spawnSync("pkill", ["-x", daemon]);
}
if (!existsSync(app)) fail(`Justus.app not found at ${app}`);

if (invite) {
  // Safari's first-run tip covers the page and Maestro cannot see it: hide all tips in Safari's
  // defaults on an erased Simulator, before Safari's first launch, then boot again so it reads them.
  run("xcrun", ["simctl", "shutdown", udid]);
  run("xcrun", ["simctl", "erase", udid]);
  run("xcrun", ["simctl", "boot", udid]);
  run("xcrun", ["simctl", "bootstatus", udid, "-b"]);
  const hide = ["spawn", udid, "defaults", "write", "com.apple.mobilesafari"];
  if (
    run("xcrun", ["simctl", ...hide, "com.apple.TipKit.HideAllTips", "-bool", "true"]).status !== 0
  )
    fail("could not hide Safari's tips");
  run("xcrun", ["simctl", "shutdown", udid]);
}
run("xcrun", ["simctl", "boot", udid]); // fails harmlessly when already booted
if (run("xcrun", ["simctl", "bootstatus", udid, "-b"]).status !== 0) fail("Simulator did not boot");
if (invite) {
  // Safari's first launch on an erased Simulator can outlast the 10 s the Simulator waits when
  // opening a URL: start it once and quit it so the walk's openLink meets a warm Safari.
  run("xcrun", ["simctl", "launch", udid, "com.apple.mobilesafari"]);
  spawnSync("sleep", ["20"]);
  run("xcrun", ["simctl", "terminate", udid, "com.apple.mobilesafari"]);
}
run("xcrun", ["simctl", "uninstall", udid, bundleId]);
if (run("xcrun", ["simctl", "install", udid, app]).status !== 0) fail("install failed");

// iPhone: enrol a Face ID so the first-run card offers App lock, and serve /match for the flow.
let face = null;
if (!ipad) {
  const enrolment = "com.apple.BiometricKit.enrollmentChanged";
  const notify = (args) => run("xcrun", ["simctl", "spawn", udid, "notifyutil", ...args]);
  notify(["-s", enrolment, "1"]);
  notify(["-p", enrolment]);
  const state = capture("xcrun", ["simctl", "spawn", udid, "notifyutil", "-g", enrolment]);
  if (!String(state.stdout).trim().endsWith("1")) fail(`Face ID enrolment did not take on ${udid}`);
  const publicDir = path.join(root, "docs/site/public");
  const types = { ".html": "text/html", ".js": "text/javascript" };
  face = createServer((request, response) => {
    // --invite: serve docs/site/public under /justus/ on this port, as GitHub Pages does.
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (invite && pathname.startsWith("/justus/")) {
      const relative = pathname.slice("/justus/".length);
      const file = path.join(
        publicDir,
        relative.endsWith("/") ? `${relative}index.html` : relative,
      );
      const inside = relative !== "" && file.startsWith(`${publicDir}${path.sep}`);
      const found = inside && existsSync(file) && statSync(file).isFile();
      response.writeHead(
        found ? 200 : 404,
        found ? { "content-type": types[path.extname(file)] ?? "text/plain" } : {},
      );
      response.end(found ? readFileSync(file) : "not found");
      return;
    }
    // /away puts Justus in the background by opening Settings, /back opens Justus again. The walk
    // asks the Simulator, not the XCTest driver: the driver's Home key press left it waiting on a
    // screenshot that timed out and killed the driver.
    const actions = {
      "/match": () => notify(["-p", "com.apple.BiometricKit_Sim.fingerTouch.match"]).status === 0,
      "/away": () => run("xcrun", ["simctl", "launch", udid, "com.apple.Preferences"]).status === 0,
      "/back": () => run("xcrun", ["simctl", "launch", udid, bundleId]).status === 0,
    };
    const done = actions[request.url ?? ""]?.() ?? false;
    if (done) console.log(`helper: ${request.url}`);
    response.writeHead(done ? 200 : 404).end(done ? "ok" : "not found");
  });
  await new Promise((resolve) => face.listen(0, "127.0.0.1", resolve));
  console.log(`Face ID enrolled, helper on port ${face.address().port}`);
}

// Maestro leaves the xcodebuild that hosts its iOS driver running when it gives up on
// "driver not ready in time"; that kills the next try's driver, so stop it first.
function stopIosDriver() {
  run("pkill", ["-f", `xcodebuild.*${udid}`]);
  run("xcrun", ["simctl", "terminate", udid, driverId]);
  // pkill does not wait: poll until the old xcodebuild is gone before the next driver starts.
  for (let waited = 0; waited < 30; waited++) {
    if (capture("pgrep", ["-f", `xcodebuild.*${udid}`]).status !== 0) {
      console.log("Old iOS driver gone");
      return;
    }
    spawnSync("sleep", ["1"]);
  }
  console.log("Old iOS driver still running");
}

// Stream Maestro's output to the job log and the attempt file as it arrives, so a hung step
// or a cancelled job still shows where it stopped.
function maestro(log) {
  return new Promise((resolve) => {
    const file = createWriteStream(log);
    let text = "";
    const faceArgs = face ? ["-e", `FACE=${face.address().port}`] : [];
    const pageArgs = invite ? ["-e", `PAGE=http://127.0.0.1:${face.address().port}`] : [];
    const child = spawn(
      "maestro",
      ["--device", udid, "test", ...faceArgs, ...pageArgs, "--test-output-dir", out, flow],
      {
        cwd: root,
        env: { ...process.env, MAESTRO_DRIVER_STARTUP_TIMEOUT: "180000" },
      },
    );
    const tee = (chunk) => {
      process.stdout.write(chunk);
      file.write(chunk);
      text += chunk.toString();
    };
    // Maestro can hang after a driver call fails: a healthy walk takes about 4 minutes.
    const hung = setTimeout(
      () => {
        tee("\nMaestro walk hung: killing it\n");
        child.kill("SIGKILL");
      },
      10 * 60 * 1000,
    );
    child.stdout.on("data", tee);
    child.stderr.on("data", tee);
    child.on("error", (error) => {
      tee(`${error.message}\n`);
      file.end(() => resolve({ status: 1, text }));
    });
    child.on("close", (code) => {
      clearTimeout(hung);
      file.end(() => resolve({ status: code ?? 1, text }));
    });
  });
}

mkdirSync(out, { recursive: true });
let status = 1;
for (let attempt = 1; attempt <= 2; attempt++) {
  stopIosDriver();
  console.log(`Maestro walk (${name}), attempt ${attempt}`);
  const result = await maestro(path.join(out, `maestro-attempt-${attempt}.txt`));
  status = result.status;
  const driverFailed = [
    "driver not ready in time",
    "XCTPerformOnMainRunLoop",
    "Maestro walk hung",
    "Simulator device failed to open", // Safari still starting when openLink asked for it
  ];
  if (status === 0 || !driverFailed.some((text) => result.text.includes(text))) break;
  console.log("The Maestro walk hit a driver or Safari-start failure: trying once more");
}
stopIosDriver();
face?.close();

// A crash during the run is a failure even when the flow passed.
const reports = path.join(homedir(), "Library/Logs/DiagnosticReports");
const crashes = existsSync(reports)
  ? readdirSync(reports).filter(
      (file) =>
        file.startsWith("Justus") &&
        file.endsWith(".ips") &&
        statSync(path.join(reports, file)).mtimeMs >= startedAt,
    )
  : [];
for (const file of crashes) {
  mkdirSync(path.join(out, "crash"), { recursive: true });
  cpSync(path.join(reports, file), path.join(out, "crash", file));
}
if (crashes.length > 0) {
  console.error(`✗ Justus crashed during the walk: ${crashes.join(", ")}`);
  status = 1;
}

if (status !== 0) {
  const logs = capture("xcrun", [
    "simctl",
    "spawn",
    udid,
    "log",
    "show",
    "--last",
    "30m",
    "--style",
    "compact",
    "--predicate",
    'process == "Justus"',
  ]);
  writeFileSync(path.join(out, "app-log.txt"), logs.stdout ?? "");
  // The web view's console (the "[welcome] lock status" lines) lands in the app's own justus-log-*.jsonl,
  // not in the system log.
  const container = capture("xcrun", ["simctl", "get_app_container", udid, bundleId, "data"]);
  const dataDir = (container.stdout ?? "").trim();
  if (container.status === 0 && dataDir !== "") {
    const found = capture("find", [dataDir, "-name", "justus-log-*.jsonl"]);
    const files = (found.stdout ?? "").split("\n").filter((file) => file !== "");
    mkdirSync(path.join(out, "web-log"), { recursive: true });
    for (const file of files) cpSync(file, path.join(out, "web-log", path.basename(file)));
  }
}
process.exit(status);
