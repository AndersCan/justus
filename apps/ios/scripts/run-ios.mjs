#!/usr/bin/env node
/**
 * Build the Justus iOS app and run it on a simulator: pick a device (the
 * first booted iPhone, else the first available iPhone), boot it if needed,
 * build, install, launch.
 *
 * Usage:
 *   pnpm run ios [-- --udid <UDID>]   (from the repo root)
 *   node apps/ios/scripts/run-ios.mjs --udid <UDID>
 *
 * Requires `pnpm run build:ios` to have produced apps/ios/justus.xcodeproj +
 * Resources (the run script builds the app target, not the asset pipeline).
 * Simulator builds need no code-signing team.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "../../..");
const iosDir = path.join(root, "apps/ios");
const project = path.join(iosDir, "justus.xcodeproj");
const scheme = "justus";
const bundleId = "io.justus.app";
const derivedDataPath = path.join(iosDir, "build/DerivedData");
const app = path.join(derivedDataPath, "Build/Products/Debug-iphonesimulator/Justus.app");

const udidArg = process.argv.indexOf("--udid");
const udid = udidArg !== -1 ? process.argv[udidArg + 1] : undefined;

if (!existsSync(project)) {
  console.error("Missing justus.xcodeproj. Run `pnpm run build:ios` first.");
  process.exit(1);
}

const simctl = (args) =>
  execFileSync("xcrun", ["simctl", ...args], { stdio: "inherit", encoding: "utf8" });

const devices = JSON.parse(
  execFileSync("xcrun", ["simctl", "list", "devices", "available", "--json"], {
    encoding: "utf8",
  }),
);
const all = Object.values(devices.devices).flat();
const target = udid
  ? { udid, name: all.find((d) => d.udid === udid)?.name ?? udid }
  : (() => {
      const state = JSON.parse(
        execFileSync("xcrun", ["simctl", "list", "devices", "--json"], { encoding: "utf8" }),
      );
      const any = Object.values(state.devices).flat();
      const booted = any.find((d) => d.state === "Booted" && d.name.includes("iPhone"));
      const available = all.find((d) => d.name.includes("iPhone"));
      return booted ?? available ?? any[0];
    })();

if (!target) {
  console.error("No simulator found. Create one with `xcrun simctl create`.");
  process.exit(1);
}

console.log(`Target: ${target.name} (${target.udid})`);
if (!isBooted(target.udid)) {
  console.log("Booting simulator...");
  simctl(["boot", target.udid]);
  simctl(["bootstatus", target.udid, "-b"]);
}

const destination = `platform=iOS Simulator,id=${target.udid}`;
console.log("Building...");
execFileSync(
  "xcodebuild",
  [
    "-project",
    project,
    "-scheme",
    scheme,
    "-configuration",
    "Debug",
    "-destination",
    destination,
    "-derivedDataPath",
    derivedDataPath,
    "build",
  ],
  { stdio: "inherit" },
);

console.log(`Installing on ${target.name}...`);
simctl(["install", target.udid, app]);
console.log(`Launching ${bundleId}...`);
simctl(["launch", target.udid, bundleId]);

function isBooted(id) {
  const booted = JSON.parse(
    execFileSync("xcrun", ["simctl", "list", "devices", "--json"], { encoding: "utf8" }),
  );
  return Object.values(booted.devices)
    .flat()
    .some((d) => d.state === "Booted" && d.udid === id);
}
