import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error plain .mjs script
import { checkFlowExpectations } from "./check-flow-expectations.mjs";
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
    m.on(awaitingDecision, { event: requestQueued, to: [addingMember], handler: (e) => ({ state: addingMember.create({ entry: e.payload, role: "member" }) }) });`,
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
});
