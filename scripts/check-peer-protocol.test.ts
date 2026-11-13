// @ts-expect-error check-peer-protocol.mjs is a plain script without type declarations
import { firstSection, latestRelease, problems, protocolOf } from "./check-peer-protocol.mjs";
import { expect, test } from "vite-plus/test";

const md = (heading: string, body: string) =>
  `# Breaking changes\n\nintro\n\n${heading}\n\n${body}\n\n## old · peer protocol 1\n\n- x\n`;

test("protocolOf reads the number, and a missing file is 1", () => {
  expect(protocolOf("export const PEER_PROTOCOL = 7;")).toBe(7);
  expect(protocolOf(undefined)).toBe(1);
});

test("firstSection takes the first section only, trimmed", () => {
  const top = firstSection(md("## Unreleased · peer protocol 4", "- a  \n\n\n"));
  expect(top).toEqual({ protocol: 4, body: "\n- a" });
  expect(firstSection("# Breaking changes\n\nno sections")).toBeUndefined();
  expect(firstSection("## Unreleased\n\n- a")).toBeUndefined();
});

test("latestRelease orders by number and ignores other tags", () => {
  expect(latestRelease(["v0.2.9", "v0.2.10", "store-screenshots", "v0.10.0", "v0.9.9"])).toBe(
    "v0.10.0",
  );
  expect(latestRelease(["v0.2.9", "v0.2.10"])).toBe("v0.2.10");
  expect(latestRelease(["v1.0.0", "v0.9.9"])).toBe("v1.0.0");
  expect(latestRelease(["store-screenshots", "v1.0"])).toBeUndefined();
});

const released = { tag: "v0.3.0", protocol: 4, top: { protocol: 4, body: "- a" } };

test("passes when the protocol is new, or the released section is untouched", () => {
  expect(problems({ protocol: 5, top: { protocol: 5, body: "- b" }, released })).toEqual([]);
  expect(problems({ protocol: 4, top: { protocol: 4, body: "- a" }, released })).toEqual([]);
  expect(
    problems({
      protocol: 4,
      top: { protocol: 4, body: "- b" },
      released: { ...released, protocol: 2 },
    }),
  ).toEqual([]);
});

test("fails when a shipped protocol's section changed, naming the next number", () => {
  const found = problems({ protocol: 4, top: { protocol: 4, body: "- a\n- b" }, released });
  expect(found).toHaveLength(1);
  expect(found[0]).toContain("set PEER_PROTOCOL = 5");
  expect(found[0]).toContain("v0.3.0");
});

test("fails when the first section and PEER_PROTOCOL disagree", () => {
  const found = problems({ protocol: 5, top: { protocol: 4, body: "- a" }, released });
  expect(found[0]).toContain("PEER_PROTOCOL = 5");
});

test("fails when BREAKING.md has no section", () => {
  expect(problems({ protocol: 4, top: undefined, released })[0]).toContain("must start with");
});
