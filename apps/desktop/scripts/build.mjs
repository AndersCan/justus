#!/usr/bin/env node
/**
 * Build the Justus desktop app (gitignored output under apps/desktop/dist).
 *
 * macOS:  dist/Justus.app/Contents/{MacOS/justus, Info.plist, Resources/…}
 * Linux:  dist/justus-linux-<arch>/{bin/justus, resources/…} + .tar.gz/.sha256
 *
 * resources/: `bare` (sidecar runtime), `desktop.bundle` (packed backend),
 * `node_modules/` (native addons offloaded by bare-pack), `WebAssets/`.
 *
 * Needs `zig` (>= 0.17) on PATH; on Linux also libgtk-3-dev and
 * libwebkit2gtk-4.1-dev. The result needs no Node at run time.
 *
 * Usage: node apps/desktop/scripts/build.mjs [--skip-web]
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const root = path.dirname(path.dirname(appDir));
const backendDir = path.join(root, "apps/backend");

const minMacos = "12.0";
const hosts = {
  darwin: { arm64: "darwin-arm64", x64: "darwin-x64" },
  linux: { arm64: "linux-arm64", x64: "linux-x64" },
};
const host = hosts[process.platform]?.[process.arch];
if (!host) {
  console.error("The desktop app builds on macOS and Linux only.");
  process.exit(1);
}
const isMac = process.platform === "darwin";

const outDir = isMac
  ? path.join(appDir, "dist/Justus.app")
  : path.join(appDir, `dist/justus-${host}`);
const resources = path.join(outDir, isMac ? "Contents/Resources" : "resources");
const hostDir = path.join(outDir, isMac ? "Contents/MacOS" : "bin");

const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: "inherit" });

console.log("Building the backend entry...");
run("pnpm", ["--filter", "@justus/backend", "run", "build"]);

rmSync(outDir, { recursive: true, force: true });
mkdirSync(resources, { recursive: true });
mkdirSync(hostDir, { recursive: true });

console.log(`Packing desktop.bundle for ${host} (addons offloaded)...`);
run("node_modules/.bin/bare-pack", [
  "--host",
  host,
  "--offload-addons",
  "--out",
  path.join(resources, "desktop.bundle"),
  path.join(backendDir, "dist/main.core.gen.js"),
]);

console.log("Copying the sidecar bare runtime...");
const bareSrc = createRequire(import.meta.url)("bare-runtime")();
const bareDst = path.join(resources, "bare");
copyFileSync(bareSrc, bareDst);
// Some installs drop the executable bit on the npm-packaged binary.
chmodSync(bareDst, 0o755);

if (!process.argv.includes("--skip-web")) {
  console.log("Building web assets...");
  run("pnpm", ["--filter", "@justus/web", "run", "build"]);
}
const webDist = path.join(root, "apps/web/dist");
if (!existsSync(path.join(webDist, "index.html"))) {
  console.error(`No web build at ${webDist}; run \`pnpm --filter @justus/web run build\`.`);
  process.exit(1);
}
cpSync(webDist, path.join(resources, "WebAssets"), { recursive: true });

console.log("Building the Zig host...");
const zigArch = { arm64: "aarch64", x64: "x86_64" }[process.arch];
const zigArgs = ["build", "-Doptimize=ReleaseSafe"];
if (isMac) {
  // An explicit target pins the deployment target to LSMinimumSystemVersion.
  const sdk = execFileSync("xcrun", ["--show-sdk-path"], { encoding: "utf8" }).trim();
  zigArgs.push(`-Dtarget=${zigArch}-macos.${minMacos}`, `-Dsdk=${sdk}`);
}
// Linux builds natively against the system GTK/WebKit; build on the oldest
// distro to support (CI: ubuntu-22.04) so the glibc floor stays low.
run("zig", zigArgs, appDir);
copyFileSync(path.join(appDir, "zig-out/bin/justus"), path.join(hostDir, "justus"));
chmodSync(path.join(hostDir, "justus"), 0o755);

if (isMac) {
  writeFileSync(
    path.join(outDir, "Contents/Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Justus</string>
  <key>CFBundleIdentifier</key><string>app.justus.desktop</string>
  <key>CFBundleExecutable</key><string>justus</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>0.0.1</string>
  <key>LSMinimumSystemVersion</key><string>${minMacos}</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`,
  );
  console.log("Ad-hoc signing...");
  run("codesign", ["--force", "--deep", "--sign", "-", outDir]);
} else {
  console.log("Creating the tarball...");
  const name = path.basename(outDir);
  const tarball = `${name}.tar.gz`;
  run("tar", ["-czf", tarball, name], path.dirname(outDir));
  const digest = createHash("sha256")
    .update(readFileSync(path.join(path.dirname(outDir), tarball)))
    .digest("hex");
  writeFileSync(path.join(path.dirname(outDir), `${tarball}.sha256`), `${digest}  ${tarball}\n`);
}

console.log(`Done: ${path.relative(root, outDir)}`);
