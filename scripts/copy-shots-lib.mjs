/** Pure helpers for `pnpm copy:shots`: which catalogue entries to shoot and what the index says. */

export const CORAL = "#ff6b5b";

/** Reads `--status <s>` and `--id <id>` (and the `--assign` flag). Unknown flags are an error. */
export function parseArgs(argv) {
  const out = { status: undefined, id: undefined, assign: false, error: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--assign") out.assign = true;
    else if (a === "--status" || a === "--id") {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) return { ...out, error: `${a} needs a value` };
      out[a.slice(2)] = v;
    } else return { ...out, error: `unknown argument ${a}` };
  }
  if (out.status !== undefined && out.status !== "draft" && out.status !== "approved") {
    return { ...out, error: "--status is draft or approved" };
  }
  return out;
}

/** Entries to shoot, in catalogue order. */
export function selectEntries(catalogue, { status, id }) {
  return Object.entries(catalogue)
    .filter(
      ([key, e]) =>
        (status === undefined || e.status === status) && (id === undefined || key === id),
    )
    .map(([key, e]) => ({ id: key, ...e }));
}

/** The text a person reads, with placeholders shown as written. */
export function indexRow(entry, result) {
  const base = { id: entry.id, text: entry.text, where: entry.where, who: entry.who };
  return result.png === undefined
    ? { ...base, png: "not reachable", reason: result.reason }
    : { ...base, png: result.png };
}

/** Why an entry has no shot when it has no scenario, or the scenario never showed it. */
export function unreachableReason(entry, scenarios, shown) {
  if (entry.screen === "") return "no screen scenario shows it yet";
  if (!(entry.screen in scenarios)) return `unknown screen "${entry.screen}"`;
  if (!shown) return `screen "${entry.screen}" does not show it`;
  return undefined;
}

/** Sets each entry's `screen` to the first scenario that showed it; entries nobody showed keep "". */
export function assignScreens(catalogue, seen) {
  const next = {};
  for (const [id, e] of Object.entries(catalogue)) {
    const screen = Object.entries(seen).find(([, ids]) => ids.has(id))?.[0] ?? "";
    next[id] = { ...e, screen };
  }
  return next;
}
