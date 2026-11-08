import {
  assignScreens,
  indexRow,
  parseArgs,
  selectEntries,
  unreachableReason,
  // @ts-expect-error plain script without type declarations
} from "./copy-shots-lib.mjs";
import { describe, expect, test } from "vite-plus/test";

const cat = {
  a: { text: "A", status: "draft", where: "w", who: "u", screen: "" },
  b: { text: "B", status: "approved", where: "w", who: "u", screen: "help" },
  c: { text: "C", status: "draft", where: "w", who: "u", screen: "help" },
};

describe("copy:shots", () => {
  test("reads flags and rejects bad ones", () => {
    expect(parseArgs(["--status", "draft", "--id", "a"])).toMatchObject({
      status: "draft",
      id: "a",
    });
    expect(parseArgs(["--assign"]).assign).toBe(true);
    expect(parseArgs(["--status"]).error).toBeTruthy();
    expect(parseArgs(["--status", "nope"]).error).toBeTruthy();
    expect(parseArgs(["--wat"]).error).toBeTruthy();
  });

  test("selects by status and id, in catalogue order", () => {
    expect(selectEntries(cat, {}).map((e: { id: string }) => e.id)).toEqual(["a", "b", "c"]);
    expect(selectEntries(cat, { status: "draft" }).map((e: { id: string }) => e.id)).toEqual([
      "a",
      "c",
    ]);
    expect(selectEntries(cat, { status: "draft", id: "b" })).toEqual([]);
  });

  test("an index row has a png or a reason, never silence", () => {
    const e = { id: "a", ...cat.a };
    expect(indexRow(e, { png: "x.png" })).toMatchObject({ png: "x.png" });
    expect(indexRow(e, { reason: "r" })).toMatchObject({ png: "not reachable", reason: "r" });
  });

  test("names why an entry has no shot", () => {
    const scenarios = { help: {} };
    expect(unreachableReason({ screen: "" }, scenarios, false)).toMatch(/no screen/);
    expect(unreachableReason({ screen: "zzz" }, scenarios, true)).toMatch(/unknown/);
    expect(unreachableReason({ screen: "help" }, scenarios, false)).toMatch(/does not show/);
    expect(unreachableReason({ screen: "help" }, scenarios, true)).toBeUndefined();
  });

  test("assigns the first scenario that showed an entry", () => {
    const next = assignScreens(cat, { gallery: new Set(["a"]), help: new Set(["a", "b"]) });
    expect(next.a.screen).toBe("gallery");
    expect(next.b.screen).toBe("help");
    expect(next.c.screen).toBe("");
  });
});
