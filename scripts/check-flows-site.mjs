import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const dir = resolve(process.argv[2] ?? "flows-site");
const pages = readdirSync(dir).filter((name) => name.endsWith(".html") && name !== "index.html");
if (pages.length === 0) {
  console.error(`check-flows-site: no pages in ${dir}`);
  process.exit(1);
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
let failed = false;
for (const name of pages) {
  const page = await browser.newPage();
  await page.goto(pathToFileURL(join(dir, name)).href);
  try {
    await page.waitForSelector("svg", { timeout: 10_000 });
  } catch {
    console.error(`check-flows-site: no svg in ${name}`);
    failed = true;
  }
  await page.close();
}
await browser.close();
if (failed) process.exit(1);
console.log(`check-flows-site: ${pages.length} pages ok`);
