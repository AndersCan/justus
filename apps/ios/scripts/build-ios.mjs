#!/usr/bin/env node
/**
 * Build the generated (gitignored) inputs for the Justus iOS app:
 *
 *   - `apps/ios/addons/*.xcframework`         (`bare-link --preset ios`)
 *   - `apps/ios/Resources/main.core.bundle`   (`bare-pack --preset ios`)
 *   - `apps/ios/Resources/WebAssets/`         (copy of the apps/web build)
 *
 * then (re)generate `apps/ios/justus.xcodeproj` via xcodegen. The manifest
 * (`apps/ios/project.yml`) is itself regenerated so the embedded addon
 * xcframework list always matches what `bare-link` emitted (xcodegen does not
 * glob framework dependencies).
 *
 * Usage:
 *   pnpm run build:ios          (from the repo root)
 *
 * Requires:
 *   - the Bare Kit native addons for the p2p stack — `apps/backend`'s
 *     dependencies must include them (corestore/hyperdrive/hyperswarm pull the
 *     native addons; keep them in `dependencies`, not `devDependencies`)
 *   - the ekrooh repo as a sibling (`../ekrooh`) holding `ios/` (BareHost SPM
 *     package) and `prebuilds/ios/BareKit.xcframework` (fetched by `npm run
 *     prebuilds`); override with `EKROOH_ROOT=/path/to/ekrooh`
 *   - `xcodegen` on PATH
 */
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "../../..");
const iosDir = path.join(root, "apps/ios");
const addonsDir = path.join(iosDir, "addons");
const resourcesDir = path.join(iosDir, "Resources");
const webAssetsDir = path.join(resourcesDir, "WebAssets");

const ekroohRoot = path.resolve(process.env.EKROOH_ROOT ?? path.join(root, "../ekrooh"));
const bareKitXcframework = path.join(ekroohRoot, "prebuilds/ios/BareKit.xcframework");
const bareHostDir = path.join(ekroohRoot, "ios");

const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: "inherit" });

for (const [label, p] of [
  ["BareKit.xcframework (prebuilds)", bareKitXcframework],
  ["BareHost SPM package (ekrooh/ios)", bareHostDir],
]) {
  if (!existsSync(p)) {
    console.error(`Missing ${label} at ${p}.`);
    console.error(
      "The ekrooh repo must sit at ../ekrooh (or point EKROOH_ROOT at it), with " +
        "`npm run prebuilds` run once to fetch prebuilds/ios/BareKit.xcframework.",
    );
    process.exit(1);
  }
}

console.log("Building the worklet bundle (apps/backend)...");
run("pnpm", ["--filter", "@justus/backend", "run", "build"]);

console.log("Linking native addons for iOS...");
rmSync(addonsDir, { recursive: true, force: true });
mkdirSync(addonsDir, { recursive: true });
run("node_modules/.bin/bare-link", ["--preset", "ios", "--out", "apps/ios/addons", "apps/backend"]);

console.log("Packing main.core.bundle for iOS...");
mkdirSync(resourcesDir, { recursive: true });
run("node_modules/.bin/bare-pack", [
  "--preset",
  "ios",
  "--out",
  "apps/ios/Resources/main.core.bundle",
  "apps/backend/dist/main.core.gen.js",
]);

console.log("Building web assets (apps/web)...");
run("pnpm", ["--filter", "@justus/web", "run", "build"]);

console.log("Copying web assets into Resources/WebAssets...");
rmSync(webAssetsDir, { recursive: true, force: true });
mkdirSync(webAssetsDir, { recursive: true });
const webBuildOut = path.join(root, "apps/web/dist");
for (const entry of readdirSync(webBuildOut)) {
  cpSync(path.join(webBuildOut, entry), path.join(webAssetsDir, entry), {
    recursive: true,
  });
}

console.log("Generating apps/ios/project.yml + justus.xcodeproj...");
writeFileSync(path.join(iosDir, "project.yml"), generateProjectYml());

run("xcodegen", ["generate"], iosDir);

console.log("Done. Run on a simulator with `pnpm run ios` (boots, builds, installs, launches).");

/** Everything the xcodeproj needs, freshly resolved so addon version bumps in
 * apps/backend's dependency graph cannot silently break the app build. */
function generateProjectYml() {
  const addons = readdirSync(addonsDir)
    .filter((f) => f.endsWith(".xcframework"))
    .sort()
    .map((f) => `      - framework: addons/${f}\n        embed: true`)
    .join("\n");

  // Pin the same bare-kit-swift SPM revision the BareHost package depends on.
  const packageSwift = readFileSync(path.join(bareHostDir, "Package.swift"), "utf8");
  const revision = packageSwift.match(/revision: "([0-9a-f]{40})"/)?.[1];
  if (!revision) {
    console.error("Could not parse bare-kit-swift revision from ekrooh/ios/Package.swift");
    process.exit(1);
  }

  const pathTo = (absolute) => path.relative(iosDir, absolute);
  const addonsBlock = addons;
  return `name: justus
options:
  bundleIdPrefix: io.justus
  deploymentTarget:
    iOS: "14.0"
  createIntermediateGroups: true
packages:
  BareHost:
    path: ${pathTo(bareHostDir)}
  BareKit:
    url: https://github.com/holepunchto/bare-kit-swift
    revision: ${revision}
targets:
  Justus:
    type: application
    platform: iOS
    deploymentTarget: "14.0"
    sources:
      - path: app
      - path: Resources/main.core.bundle
        buildPhase: resources
      - path: Resources/WebAssets
        type: folder
        buildPhase: resources
    dependencies:
      - package: BareHost
      - package: BareKit
      - framework: ${pathTo(bareKitXcframework)}
        embed: true
      # Native addons produced by \`bare-link --preset ios\` (gitignored; see
      # apps/ios/scripts/build-ios.mjs). Keep in sync with that output; the
      # script rewrites this file so the list always matches.
${addonsBlock}
    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: io.justus.app
        INFOPLIST_FILE: app/Info.plist
        SWIFT_VERSION: "5.0"
        # The prebuilt BareKit.xcframework (and the bare-link addons) provide
        # the BareKit module/headers; both the app and the SPM BareKitBridge
        # target need them on the framework search path (mirrors the reference
        # app's build settings).
        FRAMEWORK_SEARCH_PATHS:
          - "$(inherited)"
          - ${pathTo(path.dirname(bareKitXcframework))}
          - addons
        LD_RUNPATH_SEARCH_PATHS:
          - "$(inherited)"
          - "@executable_path/Frameworks"
        TARGETED_DEVICE_FAMILY: "1,2"
schemes:
  justus:
    build:
      targets:
        Justus: all
    run:
      config: Debug
`;
}
