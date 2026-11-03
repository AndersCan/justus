import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "docs/flows/manifest.json"), "utf8"));
const env = { ...process.env, VITE_TRANSPORT_MODE: "mock", MANTAQ_SEED: "1" };

let failed = false;
for (const [feature, files] of Object.entries(manifest)) {
  const run = spawnSync(
    "pnpm",
    [
      "exec",
      "mantaq-inspect",
      ...files,
      "--json",
      "--out",
      `docs/flows/${feature}.json`,
      "--no-open",
      "--check",
      "--config",
      "apps/web/vite.config.ts",
    ],
    { cwd: root, env, stdio: "inherit" },
  );
  if (run.status !== 0) {
    console.error(`flows: ${feature} failed`);
    failed = true;
  }
}
const fmt = spawnSync("pnpm", ["exec", "vp", "fmt", "docs/flows"], { cwd: root, stdio: "inherit" });
if (failed || fmt.status !== 0) process.exit(1);
