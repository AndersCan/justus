import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";

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

const site = mkdtempSync(join(tmpdir(), "flows-"));

beforeAll(() => {
  const build = spawnSync("node", ["scripts/flows.mjs", "--out", site], {
    cwd: root,
    stdio: "inherit",
  });
  if (build.status !== 0) throw new Error("flows build failed");
}, 600_000);

afterAll(() => rmSync(site, { recursive: true, force: true }));

function read(feature: string): Flow {
  return JSON.parse(readFileSync(join(site, feature, "viz.json"), "utf8"));
}

for (const feature of ["sharing", "albums", "first-run", "invite-requests"]) {
  test(`${feature} flows document every state, event and transition`, () => {
    const missing = read(feature).machines.flatMap((machine) =>
      [...machine.states, ...machine.events, ...machine.edges]
        // initial edges are probed, not declared with m.on, so inspect has no doc for them
        .filter((item) => item.kind !== "initial" && !item.doc?.trim())
        .map((item) => `${machine.id}: ${item.id}`),
    );
    expect(missing).toEqual([]);
  });
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

test("factory machines are fuzzed", () => {
  const machines = ["sharing", "albums", "first-run", "invite-requests"].flatMap((feature) => {
    const flow = read(feature) as unknown as { machines: { id: string; fuzz: unknown }[] };
    return flow.machines;
  });
  const unfuzzed = FUZZED.filter(
    (id) => !machines.some((machine) => machine.id === id && machine.fuzz !== null),
  );
  expect(unfuzzed).toEqual([]);
});
