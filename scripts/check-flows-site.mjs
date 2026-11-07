import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";
import { chromium } from "playwright";

let failed = false;
const dir = resolve(process.argv[2] ?? "site-dist");
// The site also holds non-flow pages (home, privacy); only feature pages draw diagrams.
const features = Object.keys(
  JSON.parse(readFileSync(new URL("../docs/flows/manifest.json", import.meta.url), "utf8")),
);
const pages = readdirSync(dir, { withFileTypes: true })
  .filter(
    (entry) =>
      entry.isDirectory() &&
      features.includes(entry.name) &&
      existsSync(join(dir, entry.name, "index.html")),
  )
  .map((entry) => entry.name);
if (pages.length === 0) {
  console.error(`check-flows-site: no pages in ${dir}`);
  process.exit(1);
}

// Factory machines run on an injected clock, so the inspector can fuzz them.
const FUZZED = [
  "inviteLink",
  "membership",
  "joinRequest",
  "reach",
  "onboarding",
  "people",
  "requests",
  "grants",
  "sync",
  "gallery",
  "folders",
];

function vizDocuments(name) {
  const html = readFileSync(join(dir, name, "index.html"), "utf8");
  const unescape = (text) =>
    text
      .replaceAll("&quot;", '"')
      .replaceAll("&#39;", "'")
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&amp;", "&");
  return [...html.matchAll(/data-mantaq-viz="([^"]*)"/g)].flatMap(
    (match) => JSON.parse(unescape(match[1])).machines,
  );
}

const fuzzedSeen = new Set();
const allMachines = [];
for (const name of pages) {
  const machines = vizDocuments(name);
  allMachines.push(...machines);
  for (const machine of machines) {
    if (machine.fuzz !== null) fuzzedSeen.add(machine.id);
    const missing = [...machine.states, ...machine.events, ...machine.edges]
      // initial edges are probed, not declared with m.on, so inspect has no doc for them
      .filter((item) => item.kind !== "initial" && !item.doc?.trim())
      .map((item) => item.id);
    if (missing.length > 0) {
      console.error(
        `check-flows-site: ${name}: ${machine.id} has undocumented: ${missing.join(", ")}`,
      );
      failed = true;
    }
  }
}
for (const id of FUZZED.filter((id) => !fuzzedSeen.has(id))) {
  console.error(`check-flows-site: factory machine ${id} is not fuzzed (or missing)`);
  failed = true;
}
const SITE = "https://anderscan.github.io/justus/";
const flows = readFileSync(new URL("../docs/design/sharing-flows.md", import.meta.url), "utf8");
const walks = flows.slice(flows.indexOf("\n## Walks")).split(/\n## /)[1] ?? "";
const walkLinks = [
  ...walks.matchAll(/\[([^\]]+)\]\((https:\/\/anderscan\.github\.io\/justus\/[^)]*)\)/g),
];
for (const [, text, href] of walkLinks) {
  const fail = (reason) => {
    console.error(`check-flows-site: walk "${text}": ${reason}`);
    failed = true;
  };
  const url = new URL(href);
  const machineId = url.searchParams.get("machine");
  const page = url.pathname.slice(new URL(SITE).pathname.length).replace(/\/$/, "");
  if (href.includes("step=")) fail("the link carries a step trace");
  if (machineId === null) {
    fail("the link has no machine");
    continue;
  }
  if (!pages.includes(page)) {
    fail(`${page} is not a built feature page`);
    continue;
  }
  const machine = vizDocuments(page).find((each) => each.id === machineId);
  if (!machine?.runs?.some((run) => run.name === text)) {
    fail(`machine ${machineId} on ${page} has no run with this name`);
  }
  const run = url.searchParams.get("run");
  if (run === null) fail("the link has no run");
  else if (run !== text) fail(`run "${run}" differs from the link text`);
}
if (walkLinks.length === 0) {
  console.error("check-flows-site: no walk links found under the Walks heading");
  failed = true;
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
for (const [, text, href] of walkLinks) {
  const url = new URL(href);
  const machineId = url.searchParams.get("machine");
  const page = url.pathname.slice(new URL(SITE).pathname.length).replace(/\/$/, "");
  const end = vizDocuments(page)
    .find((each) => each.id === machineId)
    ?.runs?.find((run) => run.name === text)?.end;
  if (end === undefined) continue;
  const tab = await browser.newPage();
  await tab.goto(`${origin}${url.pathname}${url.search}`);
  const reason = await (async () => {
    try {
      await tab.waitForSelector(".mantaq-machine .explore", { timeout: 10_000 });
    } catch {
      return "the page did not show a machine";
    }
    const roots = tab.locator(".mantaq-machine");
    const index = await roots.evaluateAll(
      (nodes, id) =>
        nodes.findIndex((node) =>
          JSON.parse(node.dataset.mantaqViz ?? '{"machines":[]}').machines.some(
            (machine) => machine.id === id,
          ),
        ),
      machineId,
    );
    if (index < 0) return `no viewer holds machine ${machineId}`;
    const root = roots.nth(index);
    if ((await root.locator("[data-run-missing]").count()) > 0)
      return "the page says the run is missing";
    const current = await root.locator(".explore").first().getAttribute("data-current");
    return current === end ? null : `the cursor is on "${current}", the run ends in "${end}"`;
  })();
  if (reason !== null) {
    console.error(`check-flows-site: walk "${text}": ${reason}`);
    failed = true;
  }
  await tab.close();
}
await browser.close();
server.close();
if (failed) process.exit(1);
console.log(`check-flows-site: ${pages.length} pages ok`);
