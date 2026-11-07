import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAbsolute, relative, resolve } from "node:path";
import { inspectFile } from "@mantaq/inspect";
import { machineFindings } from "@mantaq/viz";

/** Machines that must state rules, by machine id. Others may, and are not checked here. */
export const REQUIRED = {
  membership: "apps/backend/src/membership/membership-machine.ts",
  inviteLink: "apps/web/src/machines/sharing/invite-link-machine.ts",
};

/** @param {Array<{ kind: string, event?: string, ms?: number }> | null} steps */
function describeSteps(steps) {
  if (steps === null) return "(no path recorded)";
  if (steps.length === 0) return "(the initial state)";
  return steps.map((s) => (s.kind === "event" ? s.event : `advance ${s.ms}ms`)).join(" -> ");
}

/**
 * @param {{ root: string, machines: Record<string, string> }} options  paths relative to root or absolute
 * @returns {Promise<{ lines: string[], failed: boolean }>}
 */
export async function checkFlowExpectations({ root, machines }) {
  const lines = [];
  let problems = 0;
  const problem = (text) => {
    problems += 1;
    lines.push(`check-flow-expectations: ${text}`);
  };

  for (const [id, file] of Object.entries(machines)) {
    const absolute = isAbsolute(file) ? file : resolve(root, file);
    const rel = relative(root, absolute);
    const loaded = await inspectFile(absolute, { fuzz: {} });
    if (loaded.failed) {
      problem(`${id}: could not load ${rel}: ${loaded.warnings.join("; ")}`);
      continue;
    }
    for (const warning of loaded.warnings) {
      if (/expectations/i.test(warning)) problem(`${id}: ${warning}`);
    }
    const machine = loaded.machines.find((m) => m.id === id);
    if (machine === undefined) {
      problem(`${id}: no machine with this id in ${rel}`);
      continue;
    }
    const failed = machine.fuzz?.failedExpectations ?? [];
    const queues = new Map();
    for (const f of failed) {
      const key = `${f.kind}:${f.state}`;
      queues.set(key, [...(queues.get(key) ?? []), f.match]);
    }
    for (const finding of machineFindings(machine)) {
      if (finding.kind !== "neverSee" && finding.kind !== "mustSee") continue;
      const match = queues.get(`${finding.kind}:${finding.state}`)?.shift();
      problems += 1;
      if (finding.kind === "neverSee") {
        lines.push(
          `check-flow-expectations: ${id}: never-see hit`,
          `  ${finding.message}`,
          `  after: ${describeSteps(finding.steps)}`,
          `  expectation: ${id}Expectations.${finding.state}.neverSee ${match ?? ""} in ${rel}`,
        );
      } else {
        lines.push(
          `check-flow-expectations: ${id}: must-see missed`,
          `  ${finding.message}`,
          `  expectation: ${id}Expectations.${finding.state}.mustSee ${match ?? ""} in ${rel}`,
        );
      }
    }
  }

  if (problems > 0) {
    lines.push(`check-flow-expectations: ${problems} problem(s); see above`);
    return { lines, failed: true };
  }
  return { lines: ["check-flow-expectations: expectations held"], failed: false };
}

/**
 * @param {{ root: string, files: string[] }} options  paths relative to root or absolute
 * @returns {Promise<{ lines: string[], failed: boolean }>}
 */
export async function checkFlowNames({ root, files }) {
  const lines = [];
  const seen = new Set();
  for (const file of files) {
    const absolute = isAbsolute(file) ? file : resolve(root, file);
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    const rel = relative(root, absolute);
    const loaded = await inspectFile(absolute, { fuzz: false });
    if (loaded.failed) {
      lines.push(`check-flow-expectations: could not load ${rel}: ${loaded.warnings.join("; ")}`);
      continue;
    }
    for (const machine of loaded.machines) {
      for (const finding of machineFindings(machine)) {
        if (finding.kind !== "vagueName" && finding.kind !== "undocumented") continue;
        lines.push(`check-flow-expectations: ${machine.id}: ${finding.message} (${rel})`);
      }
    }
  }
  return { lines, failed: lines.length > 0 };
}

async function main() {
  process.env.VITE_TRANSPORT_MODE ??= "mock";
  const root = resolve(fileURLToPath(import.meta.url), "../..");
  const manifest = JSON.parse(readFileSync(resolve(root, "docs/flows/manifest.json"), "utf8"));
  const expectations = await checkFlowExpectations({ root, machines: REQUIRED });
  const names = await checkFlowNames({ root, files: Object.values(manifest).flat() });
  if (expectations.failed || names.failed) {
    const detail = [
      ...expectations.lines.filter((l) => !l.endsWith(" problem(s); see above")),
      ...names.lines,
    ];
    const total = detail.filter((l) => !l.startsWith("  ")).length;
    const summary = `check-flow-expectations: ${total} problem(s); see above`;
    process.stderr.write([...detail, summary].join("\n") + "\n");
    process.exit(1);
  }
  process.stdout.write(
    "check-flow-expectations: expectations held; no vague or undocumented names\n",
  );
  process.exit(0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
