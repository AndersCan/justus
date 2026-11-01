/**
 * Bare entry: runs every shared p2p scenario with the real bare-* deps.
 * Started by `scripts/test-bare.mjs` as `bare <bundle> dir=<scratch> [only=<substr>]`.
 * Exits non-zero if any scenario fails.
 */
import { bareNet } from "./net.ts";
import { makeCheck, scenarios } from "../p2p-scenarios.ts";

declare const Bare: { argv: string[]; exit(code?: number): never };

const arg = (name: string) =>
  Bare.argv.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);

const root = arg("dir");
if (!root) {
  console.error("test-bare: missing dir=<scratch>");
  Bare.exit(2);
}
const only = arg("only");
const SCENARIO_TIMEOUT_MS = 60_000;

let failed = 0;
for (const s of scenarios) {
  if (only && !s.name.includes(only)) continue;
  const started = Date.now();
  const net = await bareNet(`${root}/${scenarios.indexOf(s)}`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      s.run(net, makeCheck()),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`scenario timed out after ${SCENARIO_TIMEOUT_MS}ms`)),
          SCENARIO_TIMEOUT_MS,
        );
      }),
    ]);
    console.log(`ok   ${s.name} (${Date.now() - started}ms)`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${s.name}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  } finally {
    clearTimeout(timer);
    // Best effort: a hung teardown must not mask the verdict.
    await Promise.race([net.destroy(), new Promise((r) => setTimeout(r, 5_000))]).catch(() => {});
  }
}
console.log(failed ? `${failed} scenario(s) failed` : "all scenarios passed");
Bare.exit(failed ? 1 : 0);
