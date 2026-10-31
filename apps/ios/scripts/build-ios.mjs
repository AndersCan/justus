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
 *   node apps/ios/scripts/build-ios.mjs
 *   DEVELOPMENT_TEAM=XXXXXXXXXX JUSTUS_BUNDLE_ID=com.you.justus node apps/ios/scripts/build-ios.mjs
 *
 * Requires:
 *   - the Bare Kit native addons for the p2p stack — `apps/backend`'s
 *     dependencies must include them (corestore/hyperdrive/hyperswarm pull the
 *     native addons; keep them in `dependencies`, not `devDependencies`)
 *   - network access for SwiftPM to fetch BareHost + BareKit from the ekrooh
 *     `v<@ekrooh/bare version>` tag (no sibling ekrooh checkout needed)
 *   - `xcodegen` on PATH
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "../../..");
const iosDir = path.join(root, "apps/ios");
const addonsDir = path.join(iosDir, "addons");
const resourcesDir = path.join(iosDir, "Resources");
const webAssetsDir = path.join(resourcesDir, "WebAssets");

// BareHost (and the BareKit runtime it bundles as a SwiftPM binary target) is
// fetched from the ekrooh git tag matching the installed @ekrooh/bare, so the
// native host and the JS framework stay in lockstep.
const ekroohVersion = JSON.parse(
  readFileSync(path.join(root, "node_modules/@ekrooh/bare/package.json"), "utf8"),
).version;

// Optional: sign for a physical device (`DEVELOPMENT_TEAM=XXXXXXXXXX`), and a
// bundle ID override for personal teams that cannot claim `no.cankode.justus`.
const developmentTeam = process.env.DEVELOPMENT_TEAM;
const bundleId = process.env.JUSTUS_BUNDLE_ID ?? "no.cankode.justus";

const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: "inherit" });

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

console.log(
  "Done. Run on a simulator with `node apps/ios/scripts/run-ios.mjs` (boots, builds, installs, launches).",
);

/** Everything the xcodeproj needs, freshly resolved so addon version bumps in
 * apps/backend's dependency graph cannot silently break the app build. */
function generateProjectYml() {
  const addons = readdirSync(addonsDir)
    .filter((f) => f.endsWith(".xcframework"))
    .sort()
    .map((f) => `      - framework: addons/${f}\n        embed: true`)
    .join("\n");

  const addonsBlock = addons;
  return `name: justus
options:
  bundleIdPrefix: no.cankode
  deploymentTarget:
    iOS: "14.0"
  createIntermediateGroups: true
packages:
  # The ekrooh root package exports both BareHost and BareKit (Worklet/IPC);
  # xcodegen links every library product, and SwiftPM embeds the binary
  # BareKit.framework.
  BareHost:
    url: https://github.com/AndersCan/ekrooh
    exactVersion: ${ekroohVersion}
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
      # Native addons produced by \`bare-link --preset ios\` (gitignored; see
      # apps/ios/scripts/build-ios.mjs). Keep in sync with that output; the
      # script rewrites this file so the list always matches.
${addonsBlock}
    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: ${bundleId}
        INFOPLIST_FILE: app/Info.plist
        SWIFT_VERSION: "5.0"
        # The bare-link addons sit on the framework search path.
        FRAMEWORK_SEARCH_PATHS:
          - "$(inherited)"
          - addons
        LD_RUNPATH_SEARCH_PATHS:
          - "$(inherited)"
          - "@executable_path/Frameworks"
        TARGETED_DEVICE_FAMILY: "1,2"${
          developmentTeam
            ? `\n        DEVELOPMENT_TEAM: ${developmentTeam}\n        CODE_SIGN_STYLE: Automatic`
            : ""
        }
schemes:
  justus:
    build:
      targets:
        Justus: all
    run:
      config: Debug
`;
}
