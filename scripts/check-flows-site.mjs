import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

let failed = false;
const dir = resolve(process.argv[2] ?? "site-dist");

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
console.log("check-flows-site: overview ok");
