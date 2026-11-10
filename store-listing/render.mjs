// Saves every store image as a PNG at its final size.
// Usage: node store-listing/render.mjs [--store play|ios]
// Exit 0 all good, 1 a check failed (nothing written), 2 config problem.
import { chromium } from "@playwright/test";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readListing } from "./listing.mjs";
import { STORES } from "./stores.mjs";
import config, { root } from "./vite.config.mjs";
import { createServer } from "vite";

function chosenStores(args) {
  const at = args.indexOf("--store");
  if (at < 0) return { ok: true, stores: Object.values(STORES) };
  const store = STORES[args[at + 1]];
  if (!store)
    return { ok: false, message: `--store must be one of ${Object.keys(STORES).join(", ")}` };
  return { ok: true, stores: [store] };
}

const chosen = chosenStores(process.argv.slice(2));
if (!chosen.ok) {
  console.error(chosen.message);
  process.exit(2);
}
const listing = readListing(root);
if (!listing.ok) {
  console.error(listing.message);
  process.exit(2);
}

const server = await createServer({ ...config, server: { ...config.server, port: 0 } });
await server.listen();
const base = server.resolvedUrls.local[0];
const browser = await chromium.launch();
const done = [];
let failed = false;

for (const store of chosen.stores) {
  const page = await browser.newPage({
    viewport: { width: store.width, height: store.height },
    deviceScaleFactor: 1,
  });
  for (const image of listing.images) {
    const label = `${store.name} ${image.id}`;
    await page.goto(`${base}store-listing/image.html?store=${store.name}&id=${image.id}`);
    await page.waitForSelector("body[data-ready]");
    const result = JSON.parse(await page.evaluate(() => document.body.dataset.result));
    if (result.skip) {
      const iOS = store.name === "ios" ? "iOS " : "";
      const reason = result.skip.startsWith("Needs a landscape")
        ? "needs a landscape capture"
        : `needs ${iOS}capture ${image.capture}`;
      console.log(`skip ${store.name} ${image.id}: ${reason}`);
      continue;
    }
    for (const check of result.checks.filter((c) => !c.ok)) {
      console.error(`${label}: ${check.name}: ${check.message}`);
      failed = true;
    }
    done.push({ store, name: `${image.id}.png`, png: await page.screenshot({ type: "png" }) });
  }
  await page.close();
}
await browser.close();
await server.close();

if (failed) process.exit(1);
for (const store of chosen.stores) {
  const dir = join(root, "store-listing/out", store.name);
  mkdirSync(dir, { recursive: true });
  for (const file of readdirSync(dir)) if (file.endsWith(".png")) rmSync(join(dir, file));
}
for (const { store, name, png } of done) {
  writeFileSync(join(root, "store-listing/out", store.name, name), png);
  console.log(`${store.name} ${name} ${store.width}x${store.height}`);
}
