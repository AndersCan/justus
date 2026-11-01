import { expect, test } from "vite-plus/test";
// @ts-expect-error plain .mjs script
import { parseMarkers } from "./check-issue-refs.mjs";

test("parses ekrooh and local markers with line numbers", () => {
  const text = "a\n// WORKAROUND(ekrooh#45): x\nfoo LIMITATION(#12) bar\n";
  expect(parseMarkers(text)).toEqual([
    { line: 2, marker: "WORKAROUND(ekrooh#45)", repo: "AndersCan/ekrooh", number: 45 },
    { line: 3, marker: "LIMITATION(#12)", repo: "AndersCan/justus", number: 12 },
  ]);
});

test("ignores plain references and malformed markers", () => {
  expect(parseMarkers("see ekrooh#41\nWORKAROUND(foo)\nworkaround(#3)\nWORKAROUND(#)")).toEqual([]);
});
