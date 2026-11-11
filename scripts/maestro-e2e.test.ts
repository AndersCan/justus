import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";

const script = join(import.meta.dirname, "maestro-e2e.sh");

// Runs the script's real retry functions against a stub `maestro` and `adb`.
function run(mode: "drop-once" | "drop-twice" | "assert" | "adb-gone") {
  const dir = mkdtempSync(join(tmpdir(), "maestro-retry-"));
  const adb = join(dir, "adb");
  writeFileSync(
    adb,
    `#!/bin/sh\n${mode === "adb-gone" ? 'case "$3" in get-state) echo offline;; esac' : 'case "$3" in get-state) echo device;; esac'}\nexit 0\n`,
  );
  chmodSync(adb, 0o755);
  const driver = join(dir, "driver.sh");
  writeFileSync(
    driver,
    `set -uo pipefail
OUT_DIR="${dir}/out"; SERIAL=emulator-5554; ADB="${adb}"; FLOWS_DIR=x; ADB_RETURN_TIMEOUT=1
COUNT="${dir}/count"; echo 0 > "$COUNT"; mkdir -p "$OUT_DIR"
maestro() {
  local n=$(( $(cat "$COUNT") + 1 )); echo $n > "$COUNT"
  sleep 0.1; local d="$OUT_DIR/ts$n/logs"; mkdir -p "$d"
  case "${mode}:$n" in
    drop-once:1|drop-twice:*|adb-gone:*) echo "device offline" > "$d/maestro.log"; return 1;;
    assert:*) echo "Assertion is false" > "$d/maestro.log"; return 1;;
    *) echo ok > "$d/maestro.log"; return 0;;
  esac
}
eval "$(sed -n '/^run_maestro() {/p; /^adb_dropped() {/,/^}/p; /^wait_for_adb() {/,/^}/p; /^run_maestro_suite() {/,/^}/p' "${script}")"
run_maestro_suite; rc=$?
echo "rc=$rc calls=$(cat "$COUNT")"
`,
  );
  const r = spawnSync("bash", [driver], { encoding: "utf8", timeout: 30_000 });
  return { out: r.stdout };
}

test("one adb drop is run again and passes", () => {
  expect(run("drop-once").out).toContain("rc=0 calls=2");
});

test("two adb drops fail the suite", () => {
  expect(run("drop-twice").out).toContain("rc=1 calls=2");
});

test("an assertion failure is not run again", () => {
  expect(run("assert").out).toContain("rc=1 calls=1");
});

test("a device that never returns fails fast", () => {
  const { out } = run("adb-gone");
  expect(out).toContain("rc=1 calls=1");
  expect(out).toContain("did not come back");
});
