import { recordApkNetwork } from "../device/apk-network.mjs";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

/** A stand-in for adb: `shell <script>` plays the recorder as `mode` says; `shell kill` and `exec-out cat` act like the emulator. */
function stubAdb(mode) {
  const dir = mkdtempSync(join(tmpdir(), "adb-"));
  const adb = join(dir, "adb");
  writeFileSync(
    adb,
    `#!/bin/bash
shift 2
case "$*" in
  "shell kill "*) $2 ;;
  "exec-out cat "*) printf 'bind(7<UDP:[0.0.0.0:0]>)\\n' ;;
  *)
    case ${mode} in
      missing) echo "recorder $$ 200"; echo "/system/bin/sh: strace: inaccessible or not found" >&2; exit 127 ;;
      never) exec sleep 30 ;;
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
  it("returns the same record when stopped twice", async () => {
    const recorder = recordApkNetwork({ adb: stubAdb("records"), serial: "s", app: "a" });
    await settle();
    const first = recorder.stop();
    expect(recorder.stop()).toBe(first);
    expect(await first).toEqual({ trace: "bind(7<UDP:[0.0.0.0:0]>)\n", pid: 200, error: "" });
  });
});
