import { expect, test } from "vite-plus/test";
import { parseScreensArguments } from "./parse-screens-arguments.ts";

test("no arguments shoots light screens into the default folder", () => {
  expect(parseScreensArguments([])).toEqual({
    ok: true,
    value: { command: "shoot", out: undefined, themeChoice: "light" },
  });
});

test("reads the folder and the theme, also after the -- that pnpm passes on", () => {
  const results = [
    parseScreensArguments(["--out", "/tmp/shots", "--theme", "both"]),
    parseScreensArguments(["--", "--theme", "dark"]),
  ];
  expect(results).toEqual([
    { ok: true, value: { command: "shoot", out: "/tmp/shots", themeChoice: "both" } },
    { ok: true, value: { command: "shoot", out: undefined, themeChoice: "dark" } },
  ]);
});

test("--help and -h ask for the usage", () => {
  const results = [parseScreensArguments(["--help"]), parseScreensArguments(["-h"])];
  expect(results).toEqual([
    { ok: true, value: { command: "help" } },
    { ok: true, value: { command: "help" } },
  ]);
});

test("rejects an unknown theme, a missing folder and unknown options", () => {
  const results = [
    parseScreensArguments(["--theme", "sepia"]),
    parseScreensArguments(["--out"]),
    parseScreensArguments(["--out="]),
    parseScreensArguments(["--status", "draft"]),
  ];
  expect(results).toEqual([
    { ok: false, error: "--theme is light, dark or both, not sepia" },
    { ok: false, error: "--out needs a folder" },
    { ok: false, error: "--out needs a folder" },
    { ok: false, error: "unknown option --status" },
  ]);
});
