import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  faceRoute,
  parseEnrolled,
  readEnrolled,
  setEnrolled,
  startFaceHelper,
  // @ts-expect-error plain script without type declarations
} from "./maestro-ios-lib.mjs";
import { describe, expect, test } from "vite-plus/test";

// A stub xcrun that records its args; `notifyutil -g` prints the enrolment in STATE.
function stub(options: { state: string; fail?: boolean }) {
  const dir = mkdtempSync(path.join(tmpdir(), "xcrun-"));
  const calls = path.join(dir, "calls");
  const state = path.join(dir, "state");
  writeFileSync(state, options.state);
  writeFileSync(
    path.join(dir, "xcrun"),
    `#!/bin/sh
echo "$*" >> "${calls}"
${options.fail ? 'echo "boom" >&2; exit 1' : ""}
case "$*" in
  *"-s "*) echo "$5" > /dev/null; for last; do :; done; echo "$last" > "${state}" ;;
  *"-g "*) echo "com.apple.BiometricKit.enrollmentChanged $(cat "${state}")" ;;
esac
`,
  );
  chmodSync(path.join(dir, "xcrun"), 0o755);
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
  return { env, recorded: () => readFileSync(calls, "utf8").trim().split("\n") };
}

describe("iPhone walk Face ID helper", () => {
  test("only /match is a face route", () => {
    expect(faceRoute("/match")).toBe("match");
    expect(faceRoute("/other")).toBeNull();
    expect(faceRoute("/match/")).toBeNull();
  });

  test("reads the enrolment from notifyutil output", () => {
    expect(parseEnrolled("com.apple.BiometricKit.enrollmentChanged 1\n")).toBe(true);
    expect(parseEnrolled("com.apple.BiometricKit.enrollmentChanged 0\n")).toBe(false);
  });

  test("enrols and restores the original state", async () => {
    for (const was of ["0", "1"]) {
      const { env, recorded } = stub({ state: was });
      const before = await readEnrolled("U", env);
      expect(before).toBe(was === "1");
      expect(await setEnrolled("U", true, env)).toBe(true);
      expect(await setEnrolled("U", before, env)).toBe(true);
      expect(await readEnrolled("U", env)).toBe(before);
      expect(
        recorded().some((call) => call.includes("-s com.apple.BiometricKit.enrollmentChanged 1")),
      ).toBe(true);
    }
  });

  test("/match posts the match notification, other paths are 404", async () => {
    const { env, recorded } = stub({ state: "1" });
    const helper = await startFaceHelper("U", env);
    const ok = await fetch(`http://127.0.0.1:${helper.port}/match`);
    expect(ok.status).toBe(200);
    expect(recorded().at(-1)).toBe(
      "simctl spawn U notifyutil -p com.apple.BiometricKit_Sim.fingerTouch.match",
    );
    const other = await fetch(`http://127.0.0.1:${helper.port}/other`);
    expect(other.status).toBe(404);
    expect(recorded()).toHaveLength(1);
    helper.close();
  });
});

describe("iPhone walk Face ID helper errors", () => {
  test("a failing xcrun gives 500 with its error", async () => {
    const { env } = stub({ state: "1", fail: true });
    const helper = await startFaceHelper("U", env);
    const response = await fetch(`http://127.0.0.1:${helper.port}/match`);
    expect(response.status).toBe(500);
    expect(await response.text()).toContain("boom");
    helper.close();
  });

  test("enrolment that does not take reports false", async () => {
    const { env } = stub({ state: "0", fail: true });
    expect(await setEnrolled("U", true, env)).toBe(false);
  });
});
