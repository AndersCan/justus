import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

let failed = false;
const dir = resolve(process.argv[2] ?? "site-dist");

const overview = readFileSync(join(dir, "flows", "index.html"), "utf8");
if (!overview.includes("mantaq-machines")) {
  console.error("check-flows-site: flows/index.html has no .mantaq-machines overview");
  failed = true;
}

if (failed) process.exit(1);
console.log("check-flows-site: overview ok");
