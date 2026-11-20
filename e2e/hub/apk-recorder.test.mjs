import { recordApkNetwork } from "../device/apk-network.mjs";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

/** A stand-in for adb: `shell <script>` plays the recorder as `mode` says; `shell kill` and `exec-out cat` act like the emulator. */
function stubAdb(mode) {
  const dir = mkdtempSync(join(tmpdir(), "adb-"));
  const adb = join(dir, "adb");
  const fake = join(dir, "fake");
  mkdirSync(join(fake, "bin"), { recursive: true });
  // pidof: pid 100 first, then 101 once the first strace has seen its process die. strace: the first process dies after 0.3s.
  writeFileSync(
    join(fake, "bin", "pidof"),
    `#!/bin/bash\nif [ -e ${fake}/died ]; then echo 101; else echo 100; fi\n`,
  );
  writeFileSync(
    join(fake, "bin", "strace"),
    `#!/bin/bash
while [ "$1" != -o ]; do shift; done
out=$2; pid=\${4}
echo "bind($pid)" > $out
if [ $pid = 100 ]; then sleep 0.3; touch ${fake}/died; exit 0; fi
trap 'exit 0' TERM
while :; do sleep 0.05; done
`,
  );
  chmodSync(join(fake, "bin", "pidof"), 0o755);
  chmodSync(join(fake, "bin", "strace"), 0o755);
  writeFileSync(
    adb,
    `#!/bin/bash
FAKE=${fake}
shift 2
case "$*" in
  "shell kill "*) $2 ;;
  "exec-out sh -c cat "*) if ls "$FAKE"/justus-net.trace.* >/dev/null 2>&1; then sh -c "\${4//\\/data\\/local\\/tmp/$FAKE}"; else printf 'bind(7<UDP:[0.0.0.0:0]>)\\n'; fi ;;
  *)
    case ${mode} in
      missing) echo "recorder $$ 200"; echo "/system/bin/sh: strace: inaccessible or not found" >&2; exit 127 ;;
      never) exec sleep 30 ;;
      restarts) FAKE=${fake} PATH="${fake}/bin:$PATH" bash -c "\${2//\\/data\\/local\\/tmp/${fake}}" ;;
      nostrace) rm "$FAKE"/bin/strace; PATH="$FAKE/bin:/usr/bin:/bin" sh -c "\${2//\\/data\\/local\\/tmp/$FAKE}" ;;
      offline) echo "recorder $$ 200"; sleep 0.3; echo "error: device offline" >&2; exit 1 ;;
      records) echo "recorder $$ 200"; trap 'exit 0' INT; while :; do sleep 0.05; done ;;
    esac ;;
esac
`,
  );
  chmodSync(adb, 0o755);
  return adb;
}

function settle() {
  return new Promise((resolve) => setTimeout(resolve, 300));
}

describe("recordApkNetwork", () => {
  it("returns an error, not an empty record, when strace is missing", async () => {
    const recorder = recordApkNetwork({ adb: stubAdb("missing"), serial: "s", app: "a" });
    await settle();
    expect(await recorder.stop()).toEqual({
      trace: "",
      pid: 0,
      error: "the recorder stopped early: /system/bin/sh: strace: inaccessible or not found",
    });
  });
  it("returns an error when the app never starts", async () => {
    const recorder = recordApkNetwork({ adb: stubAdb("never"), serial: "s", app: "a" });
    await settle();
    expect((await recorder.stop()).error).toBe("Ben's app never started while recording");
  });
  it("keeps recording when the app process dies and a new one starts", async () => {
    const recorder = recordApkNetwork({ adb: stubAdb("restarts"), serial: "s", app: "a" });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const seen = await recorder.stop();
    expect(seen.error).toBe("");
    expect(seen.trace).toContain("bind(100)");
    expect(seen.trace).toContain("bind(101)");
  });
  it("returns an error when the recorder script cannot find strace", async () => {
    const recorder = recordApkNetwork({ adb: stubAdb("nostrace"), serial: "s", app: "a" });
    await settle();
    const seen = await recorder.stop();
    expect(seen.error).toMatch(/^the recorder stopped early: .*strace.*not found/);
  });
  it("still records when the adb connection drops for a moment (run 44670220846: device offline before step 11)", async () => {
    const recorder = recordApkNetwork({ adb: stubAdb("offline"), serial: "s", app: "a" });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect((await recorder.stop()).error).toBe("");
  });
  it("returns the same record when stopped twice", async () => {
    const recorder = recordApkNetwork({ adb: stubAdb("records"), serial: "s", app: "a" });
    await settle();
    const first = recorder.stop();
    expect(recorder.stop()).toBe(first);
    expect(await first).toEqual({ trace: "bind(7<UDP:[0.0.0.0:0]>)\n", pid: 200, error: "" });
  });
});
