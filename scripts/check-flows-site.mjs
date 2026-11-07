import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

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

for (const name of pages) {
  const machines = vizDocuments(name);
  for (const machine of machines) {
    const missing = machine.edges
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

const overview = readFileSync(join(dir, "flows", "index.html"), "utf8");
if (!overview.includes("mantaq-machines")) {
  console.error("check-flows-site: flows/index.html has no .mantaq-machines overview");
  failed = true;
}
for (const [from, to] of [["membership", "joinRequest"]]) {
  const link = new RegExp(`class="[^"]*\\blink\\b[^"]*" data-from="${from}" data-to="${to}"`);
  if (!link.test(overview)) {
    console.error(`check-flows-site: flows overview has no link from ${from} to ${to}`);
    failed = true;
  }
}

if (failed) process.exit(1);
console.log(`check-flows-site: ${pages.length} pages ok`);
