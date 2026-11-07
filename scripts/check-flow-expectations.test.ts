import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error plain .mjs script
import { checkFlowExpectations, checkFlowNames } from "./check-flow-expectations.mjs";
import { afterAll, expect, test } from "vite-plus/test";

const root = resolve(fileURLToPath(import.meta.url), "../..");
const cache = resolve(root, "node_modules/.cache/check-flow-expectations");

afterAll(() => {
  rmSync(cache, { recursive: true, force: true });
});

test("a handler that skips the Admin's accept is reported as a never-see hit", async () => {
  const dir = resolve(cache, "planted-break");
  mkdirSync(dir, { recursive: true });
  const source = resolve(root, "apps/backend/src/membership");
  cpSync(resolve(source, "records.ts"), resolve(dir, "records.ts"));
  const marker = "setup: (m) => {";
  const original = readFileSync(resolve(source, "membership-machine.ts"), "utf8");
  expect(original).toContain(marker);
  const planted = original.replace(
    marker,
    `${marker}
    m.on(requestWaitingForAdmin, { event: requestQueued, to: [addingMember], handler: (e) => ({ state: addingMember.create({ entry: e.payload, role: "member" }) }) });`,
  );
  const file = resolve(dir, "membership-machine.ts");
  writeFileSync(file, planted);

  const { lines, failed } = (await checkFlowExpectations({
    root,
    machines: { membership: file },
  })) as { lines: string[]; failed: boolean };

  console.log(lines.join("\n"));
  expect(failed).toBe(true);
  expect(lines).toContain("check-flow-expectations: membership: never-see hit");
  expect(lines).toContain('  state addingMember reached never-see context {"accepted":false}');
  expect(
    lines.some((l) => l.startsWith("  after: ") && l.includes("requestQueued -> requestQueued")),
  ).toBe(true);
}, 30_000);

test("a vague event name and an undocumented state are reported", async () => {
  const dir = resolve(cache, "planted-names");
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, "planted-machine.ts");
  writeFileSync(
    file,
    `import { Actor, event, state, type Clock } from "@mantaq/core";

const showingCart = state("showingCart")();
/** The cart was paid for. */
const cartPaid = state("cartPaid")();
const paid = cartPaid.final();
/** Something loaded. */
const LOADED = event("LOADED")();

export function createPlantedActor(options: { clock: Clock }) {
  return Actor({
    id: "planted",
    inputs: [LOADED],
    outputs: [],
    states: [showingCart, paid],
    initial: showingCart,
    clock: options.clock,
    context: {},
    setup: (m) => {
      /** The cart loaded and was paid. */
      m.on(showingCart, { event: LOADED, to: [paid], handler: () => ({ state: paid }) });
    },
  });
}
`,
  );

  const { lines, failed } = (await checkFlowNames({ root, files: [file, file] })) as {
    lines: string[];
    failed: boolean;
  };

  console.log(lines.join("\n"));
  const rel = "node_modules/.cache/check-flow-expectations/planted-names/planted-machine.ts";
  expect(failed).toBe(true);
  expect(lines).toContain(
    `check-flow-expectations: planted: event LOADED has a vague name (only generic words: loaded); name what happened, like photosLoaded (${rel})`,
  );
  expect(lines.some((l) => l.includes("state showingCart has no doc comment"))).toBe(true);
  expect(lines.filter((l) => l.includes("LOADED"))).toHaveLength(1);
}, 30_000);

test("every machine in the flow manifest has clear, documented names", async () => {
  const manifest = JSON.parse(readFileSync(resolve(root, "docs/flows/manifest.json"), "utf8"));
  const { lines, failed } = (await checkFlowNames({
    root,
    files: Object.values(manifest).flat() as string[],
  })) as { lines: string[]; failed: boolean };
  expect(lines).toEqual([]);
  expect(failed).toBe(false);
}, 60_000);
