// Live viz page for named machines, redrawn on save.
// Usage: pnpm flows:dev [feature|file ...]
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mantaqViz } from "@mantaq/inspect/vite";
import { createServer } from "vite";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "docs/flows/manifest.json"), "utf8"));
process.env.VITE_TRANSPORT_MODE = "mock";
process.env.MANTAQ_SEED = "1";

const targets = process.argv.slice(2);
const files = [];
for (const target of targets.length === 0 ? Object.keys(manifest) : targets) {
  const listed = Object.hasOwn(manifest, target) ? manifest[target] : undefined;
  const path = resolve(root, target);
  if (listed) files.push(...listed.map((file) => join(root, file)));
  else if (target.endsWith(".ts") && existsSync(path)) files.push(path);
  else {
    console.error(
      `flows:dev: "${target}" is neither a feature in docs/flows/manifest.json nor a file. Features: ${Object.keys(manifest).join(", ")}`,
    );
    process.exit(1);
  }
}

const server = await createServer({
  root,
  configFile: join(root, "apps/web/vite.flows.config.ts"),
  plugins: [mantaqViz({ machines: [...new Set(files)] })],
  server: { host: "127.0.0.1", port: 5180, strictPort: false },
});
await server.listen();
console.log(`flows:dev: ${server.resolvedUrls?.local[0]}__mantaq/`);
