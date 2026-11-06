import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mantaqViz } from "@mantaq/inspect/astro";
import { defineConfig } from "astro/config";

process.env.VITE_TRANSPORT_MODE = "mock";
process.env.MANTAQ_SEED = "1";

const manifest = JSON.parse(
  readFileSync(new URL("../flows/manifest.json", import.meta.url), "utf8"),
);

export default defineConfig({
  // root = repo root, so machine paths match docs/flows/manifest.json
  root: fileURLToPath(new URL("../..", import.meta.url)),
  srcDir: "./docs/site/src",
  outDir: "./site-dist",
  publicDir: "./docs/site/public",
  site: "https://anderscan.github.io",
  base: "/justus",
  vite: { define: { "import.meta.env.VITE_TRANSPORT_MODE": JSON.stringify("mock") } },
  integrations: [mantaqViz({ machines: Object.values(manifest).flat() })],
});
