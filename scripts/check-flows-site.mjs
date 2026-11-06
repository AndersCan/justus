import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";
import { chromium } from "playwright";

const dir = resolve(process.argv[2] ?? "flows-site");
const pages = readdirSync(dir, { withFileTypes: true })
  .filter(
    (entry) =>
      entry.isDirectory() &&
      entry.name !== "_astro" &&
      existsSync(join(dir, entry.name, "index.html")),
  )
  .map((entry) => entry.name);
if (pages.length === 0) {
  console.error(`check-flows-site: no pages in ${dir}`);
  process.exit(1);
}

const BASE = "/justus";
const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".json": "application/json",
  ".css": "text/css",
  ".svg": "image/svg+xml",
};
const server = createServer((request, response) => {
  const full = new URL(request.url ?? "/", "http://localhost").pathname;
  if (!full.startsWith(`${BASE}/`)) {
    response.writeHead(404).end();
    return;
  }
  const path = full.slice(BASE.length);
  const file = resolve(dir, `.${path.endsWith("/") ? `${path}index.html` : path}`);
  if (!file.startsWith(dir) || !existsSync(file)) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "text/plain" });
  response.end(readFileSync(file));
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
let failed = false;
for (const name of pages) {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.location().url.endsWith("/favicon.ico"))
      errors.push(message.text());
  });
  await page.goto(`${origin}${BASE}/${name}/`);
  try {
    await page.waitForSelector("svg", { timeout: 10_000 });
  } catch {
    console.error(`check-flows-site: no svg in ${name}`);
    failed = true;
  }
  const machines = page.locator(".mantaq-machine");
  const machineCount = await machines.count();
  const findingsCount = await page.locator(".mantaq-findings").count();
  if (machineCount === 0 || findingsCount !== machineCount) {
    console.error(
      `check-flows-site: ${name}: ${findingsCount} .mantaq-findings for ${machineCount} .mantaq-machine`,
    );
    failed = true;
  }
  for (let machine = 0; machine < machineCount; machine++) {
    const root = machines.nth(machine);
    const live = (await root.innerText()).includes("Live: the real machine runs");
    if (!live) continue;
    const before = await root.locator(".explore").first().getAttribute("data-current");
    const sends = await root.locator("[data-send]").count();
    let moved = false;
    for (let index = 0; index < sends && !moved; index++) {
      await root.locator("[data-send]").nth(index).click();
      moved = (await root.locator(".explore").first().getAttribute("data-current")) !== before;
    }
    if (!moved) {
      console.error(`check-flows-site: no event moved the cursor in ${name} (machine ${machine})`);
      failed = true;
    }
  }
  for (const error of errors) {
    console.error(`check-flows-site: ${name}: ${error}`);
    failed = true;
  }
  await page.close();
}
await browser.close();
server.close();
if (failed) process.exit(1);
console.log(`check-flows-site: ${pages.length} pages ok`);
