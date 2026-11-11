import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import mdx from "@astrojs/mdx";
import starlight from "@astrojs/starlight";
import { mantaqViz } from "@mantaq/inspect/astro";
import { defineConfig } from "astro/config";

process.env.VITE_TRANSPORT_MODE = "mock";
process.env.MANTAQ_SEED = "1";

const base = process.env.SITE_BASE ?? "/justus";
if (!/^\/justus(\/pr\/[1-9]\d*)?$/.test(base)) {
  throw new Error(`SITE_BASE must be /justus or /justus/pr/<number>, got "${base}"`);
}

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
  base,
  redirects: {
    "/albums": `${base}/make-an-album/`,
    "/sharing": `${base}/join-an-album/`,
    "/app": `${base}/internals/`,
  },
  vite: { define: { "import.meta.env.VITE_TRANSPORT_MODE": JSON.stringify("mock") } },
  integrations: [
    mantaqViz({ machines: Object.values(manifest).flat(), failOnFindings: true }),
    starlight({
      title: "Justus",
      logo: {
        light: "./assets/brand/justus-wordmark.svg",
        dark: "./assets/brand/justus-wordmark-dark.svg",
        replacesTitle: true,
      },
      customCss: [
        "./apps/web/src/design/justus/tokens/theme.css",
        "./apps/web/src/tokens.css",
        "./docs/site/src/styles/brand.css",
      ],
      description: "Private photo sharing, directly between devices.",
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/AndersCan/justus" }],
      sidebar: [
        {
          label: "Flows",
          items: [{ slug: "flows" }, ...Object.keys(manifest).map((slug) => ({ slug }))],
        },
        { slug: "privacy" },
      ],
    }),
    mdx(),
  ],
});
