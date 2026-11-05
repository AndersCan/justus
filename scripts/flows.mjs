import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mantaqViz } from "@mantaq/inspect/vite";
import { build } from "vite";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "docs/flows/manifest.json"), "utf8"));
process.env.VITE_TRANSPORT_MODE = "mock";
process.env.MANTAQ_SEED = "1";

const outFlag = process.argv.indexOf("--out");
const outDir = resolve(outFlag === -1 ? "flows-site" : (process.argv[outFlag + 1] ?? "flows-site"));
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

let failed = false;
for (const [feature, files] of Object.entries(manifest)) {
  try {
    await build({
      root,
      configFile: join(root, "apps/web/vite.flows.config.ts"),
      logLevel: "warn",
      plugins: [mantaqViz({ machines: files.map((file) => join(root, file)), base: "/" })],
      build: { outDir: join(outDir, feature), emptyOutDir: true },
    });
  } catch (error) {
    console.error(`flows: ${feature} failed`, error);
    failed = true;
  }
}
if (failed) process.exit(1);

const items = Object.entries(manifest)
  .map(
    ([feature, files]) =>
      `    <li><a href="${feature}/">${feature}</a>: ${files
        .map((file) => file.replace(/^.*\//, "").replace(/\.ts$/, ""))
        .join(", ")}</li>`,
  )
  .join("\n");
writeFileSync(
  join(outDir, "index.html"),
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
