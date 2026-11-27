import { expect, test } from "vite-plus/test";
import { parseScreensArguments } from "./parse-screens-arguments.ts";

test("no arguments shoots light screens into the default folder", () => {
  expect(parseScreensArguments([])).toEqual({
    ok: true,
    value: { out: undefined, themeChoice: "light" },
  });
});

test("reads the folder and the theme", () => {
  expect(parseScreensArguments(["--out", "/tmp/shots", "--theme", "both"])).toEqual({
    ok: true,
    value: { out: "/tmp/shots", themeChoice: "both" },
  });
});

test("rejects an unknown theme, a missing folder and unknown options", () => {
  const results = [
    parseScreensArguments(["--theme", "sepia"]),
    parseScreensArguments(["--out"]),
    parseScreensArguments(["--status", "draft"]),
  ];
  expect(results).toEqual([
    { ok: false, error: "--theme is light, dark or both" },
    { ok: false, error: "--out needs a folder" },
    { ok: false, error: "unknown option --status" },
  ]);
});
