import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
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

type Item = { id: string; doc: string | null; kind?: string };
type Flow = { machines: { id: string; states: Item[]; events: Item[]; edges: Item[] }[] };

function read(feature: string): Flow {
  return JSON.parse(
    readFileSync(new URL(`../docs/flows/${feature}.json`, import.meta.url), "utf8"),
  );
}

for (const feature of ["sharing", "albums", "first-run"]) {
  test(`${feature} flows document every state, event and transition`, () => {
    const missing = read(feature).machines.flatMap((machine) =>
      [...machine.states, ...machine.events, ...machine.edges]
        // effect edges are probed, not declared with m.on, so inspect has no doc for them
        .filter((item) => item.kind !== "effect" && !item.doc?.trim())
        .map((item) => `${machine.id}: ${item.id}`),
    );
    expect(missing).toEqual([]);
  });
}
