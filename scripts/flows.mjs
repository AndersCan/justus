import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "docs/flows/manifest.json"), "utf8"));
const env = { ...process.env, VITE_TRANSPORT_MODE: "mock", MANTAQ_SEED: "1" };

const htmlFlag = process.argv.indexOf("--html");
if (htmlFlag !== -1) {
  const htmlDir = resolve(process.argv[htmlFlag + 1] ?? "flows-site");
  mkdirSync(htmlDir, { recursive: true });
  let htmlFailed = false;
  for (const [feature, files] of Object.entries(manifest)) {
    const run = spawnSync(
      "pnpm",
      [
        "exec",
        "mantaq-inspect",
        ...files,
        "--out",
        join(htmlDir, `${feature}.html`),
        "--no-open",
        "--config",
        "apps/web/vite.config.ts",
      ],
      { cwd: root, env, stdio: "inherit" },
    );
    if (run.status !== 0) {
      console.error(`flows: ${feature} failed`);
      htmlFailed = true;
    }
  }
  if (htmlFailed) process.exit(1);
  const items = Object.entries(manifest)
    .map(
      ([feature, files]) =>
        `    <li><a href="${feature}.html">${feature}</a>: ${files
          .map((file) => file.replace(/^.*\//, "").replace(/\.ts$/, ""))
          .join(", ")}</li>`,
    )
    .join("\n");
  writeFileSync(
    join(htmlDir, "index.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Justus flows</title>
  </head>
  <body>
    <h1>Justus flows</h1>
    <ul>
${items}
    </ul>
  </body>
</html>
`,
  );
  process.exit(0);
}

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
if (failed) process.exit(1);
const fmt = spawnSync("pnpm", ["exec", "vp", "fmt", "docs/flows"], { cwd: root, stdio: "inherit" });
if (fmt.status !== 0) process.exit(1);
