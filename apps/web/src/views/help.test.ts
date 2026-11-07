import { describe, expect, test } from "vite-plus/test";
import { HELP_QA } from "./help";

const answers = HELP_QA.flatMap((item) => item.a);
const everything = HELP_QA.flatMap((item) => [item.q, ...item.a]);

describe("help copy", () => {
  test("album visibility says a link alone shows no photos", () => {
    const item = HELP_QA.find((x) => x.q === "Who can see an album?");
    expect(item?.a.some((p) => p.includes("shows no photos"))).toBe(true);
  });

  test("no stale invite-link claims", () => {
    for (const p of answers) {
      expect(p).not.toContain("before the Admin approves");
      expect(p).not.toContain("kept the invite link");
    }
  });

  test("backup answer follows lost phone", () => {
    const qs = HELP_QA.map((x) => x.q);
    expect(qs.indexOf("Is Justus a backup?")).toBe(qs.indexOf("What if I lose my phone?") + 1);
  });

  test("avoids words the glossary rejects", () => {
    for (const t of everything) {
      expect(t).not.toMatch(/owner|online/i);
    }
  });
});
