#!/usr/bin/env node
// Walks .maestro/flows/first-run.yaml on an iPhone or iPad Simulator: builds the Debug app,
// boots the first available Simulator, installs, and runs Maestro (up to the share menu).
// CI glue for .github/workflows/ios-device.yml; the green run is its test.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const flow = ".maestro/flows/first-run.yaml";
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

// The newest iOS runtime's first available iPhone, an already booted one first.
// iPhone SE models have Touch ID, not Face ID.
function pickSimulator() {
  const list = JSON.parse(
    capture("xcrun", ["simctl", "list", "devices", "available", "-j"]).stdout,
  );
  const runtimes = Object.keys(list.devices)
    .filter((name) => name.includes("SimRuntime.iOS-"))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const runtime of runtimes) {
    const matches = list.devices[runtime].filter(
      (device) => device.name.startsWith("iPhone") && !device.name.includes("SE"),
    );
    const booted = matches.find((device) => device.state === "Booted");
    const chosen = booted ?? matches[0];
    if (chosen) return chosen;
  }
  return null;
}

const device = pickSimulator();
if (!device) fail("no iPhone Simulator: install an iOS runtime");
const { udid, name } = device;
console.log(`Simulator: ${name} (${udid})`);

if (process.env.JUSTUS_IOS_SKIP_BUILD !== "1") {
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
}
if (!existsSync(app)) fail(`Justus.app not found at ${app}`);

run("xcrun", ["simctl", "boot", udid]); // fails harmlessly when already booted
if (run("xcrun", ["simctl", "bootstatus", udid, "-b"]).status !== 0) fail("Simulator did not boot");
run("xcrun", ["simctl", "uninstall", udid, bundleId]);
if (run("xcrun", ["simctl", "install", udid, app]).status !== 0) fail("install failed");

// Maestro leaves the xcodebuild that hosts its iOS driver running when it gives up on
// "driver not ready in time"; that kills the next try's driver, so stop it first.
function stopIosDriver() {
  run("pkill", ["-f", `xcodebuild.*${udid}`]);
  run("xcrun", ["simctl", "terminate", udid, driverId]);
  // pkill does not wait: give the old xcodebuild a moment to go before the next driver starts.
  spawnSync("sleep", ["5"]);
}

mkdirSync(out, { recursive: true });
let status = 1;
for (let attempt = 1; attempt <= 2; attempt++) {
  stopIosDriver();
  console.log(`Maestro walk (${name}), attempt ${attempt}`);
  const log = path.join(out, `maestro-attempt-${attempt}.txt`);
  const result = spawnSync("maestro", ["--device", udid, "test", "--test-output-dir", out, flow], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, MAESTRO_DRIVER_STARTUP_TIMEOUT: "180000" },
    maxBuffer: 256 * 1024 * 1024,
  });
  const text = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  process.stdout.write(text);
  writeFileSync(log, text);
  status = result.status ?? 1;
  if (status === 0 || !text.includes("driver not ready in time")) break;
  console.log("The Maestro iOS driver did not start: trying once more");
}
stopIosDriver();

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
}
process.exit(status);
