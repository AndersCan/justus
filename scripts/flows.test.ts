import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectFile } from "@mantaq/inspect";
import { expect, test } from "vite-plus/test";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const manifest: Record<string, string[]> = JSON.parse(
  readFileSync(join(root, "docs/flows/manifest.json"), "utf8"),
);
const listed = Object.values(manifest).flat();

function machineFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : machineFiles(path);
    return entry.name.endsWith("-machine.ts") ? [relative(root, path)] : [];
  });
}

test("every machine file is in the flows manifest", () => {
  const found = ["apps/web/src", "apps/backend/src"].flatMap((dir) =>
    machineFiles(join(root, dir)),
  );
  expect(found.filter((file) => !listed.includes(file))).toEqual([]);
});

test("every manifest path exists", () => {
  expect(listed.filter((file) => !existsSync(join(root, file)))).toEqual([]);
});

test("every manifest file is shown on its feature page", () => {
  const missing = Object.entries(manifest).flatMap(([feature, files]) => {
    const page = readFileSync(join(root, "docs/site/src/content/docs", `${feature}.mdx`), "utf8");
    return files.filter((file) => !page.includes(`src="${file}"`));
  });
  expect(missing).toEqual([]);
});

test("every state a page names exists, and journey pages name some", async () => {
  const statesOf = new Map<string, Set<string>>();
  for (const file of listed) {
    const loaded = await inspectFile(join(root, file), {});
    for (const machine of loaded.machines) {
      statesOf.set(machine.id, new Set(machine.states.map((state) => state.id)));
    }
  }
  const problems: string[] = [];
  for (const key of ["flows", ...Object.keys(manifest)]) {
    const page = readFileSync(join(root, "docs/site/src/content/docs", `${key}.mdx`), "utf8");
    const cited = [...page.matchAll(/`([a-z][A-Za-z]*)\.([a-z][A-Za-z]*)`/g)];
    for (const [, id, state] of cited) {
      const states = statesOf.get(id);
      if (states === undefined) problems.push(`${key}: ${id}.${state}: no machine ${id}`);
      else if (!states.has(state)) {
        problems.push(`${key}: ${id}.${state}: ${id} has ${[...states].join(", ")}`);
      }
    }
    if (key !== "flows" && key !== "internals" && cited.length === 0) {
      problems.push(`${key}: names no state`);
    }
  }
  expect(problems).toEqual([]);
}, 120_000);

test("pages link inside the site, not to anderscan.github.io/justus", () => {
  const dir = join(root, "docs/site/src/content/docs");
  const found: string[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".mdx"))) {
    readFileSync(join(dir, file), "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (line.includes("https://anderscan.github.io/justus/") || line.includes('"/justus/')) {
          found.push(`${file}:${i + 1}`);
        }
      });
  }
  expect(found).toEqual([]);
});

test("every walk link in sharing-flows.md is named after its run", () => {
  const flows = readFileSync(join(root, "docs/design/sharing-flows.md"), "utf8");
  const walks = flows.slice(flows.indexOf("\n## Walks")).split(/\n## /)[1] ?? "";
  const links = [
    ...walks.matchAll(/\[([^\]]+)\]\((https:\/\/anderscan\.github\.io\/justus\/[^)]*)\)/g),
  ];
  expect(links.length).toBeGreaterThan(0);
  expect(
    links
      .filter(([, text, href]) => new URL(href).searchParams.get("run") !== text)
      .map(([, text]) => text),
  ).toEqual([]);
});

test("every walk link in sharing-flows.md names a machine and carries no step trace", () => {
  const flows = readFileSync(join(root, "docs/design/sharing-flows.md"), "utf8");
  const walks = flows.slice(flows.indexOf("\n## Walks")).split(/\n## /)[1] ?? "";
  const links = [
    ...walks.matchAll(/\[([^\]]+)\]\((https:\/\/anderscan\.github\.io\/justus\/[^)]*)\)/g),
  ];
  expect(links.length).toBeGreaterThan(0);
  expect(
    links
      .filter(([, , href]) => {
        const params = new URL(href).searchParams;
        return !params.get("machine") || !params.get("run") || params.has("step");
      })
      .map(([, text]) => text),
  ).toEqual([]);
});
