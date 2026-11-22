import { expect, test } from "vite-plus/test";
import { designVariables } from "./design-variables.ts";
import { readFileSync } from "node:fs";

const designCss = readFileSync(
  new URL("../../apps/web/src/design/justus/design.css", import.meta.url),
  "utf8",
);

test("keeps the theme variables on :root and [data-theme], in light, dark and reduced motion", () => {
  const css = `/* header */
:root { --canvas: 1 2 3; color-scheme: light; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --canvas: 4 5 6; } }
:root[data-theme="dark"], [data-theme="dark"] { --canvas: 4 5 6; }
@media (prefers-reduced-motion: reduce) { :root { --duration-fast: 0s; } }`;
  expect(designVariables(css)).toBe(`:root { --canvas: 1 2 3; color-scheme: light; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --canvas: 4 5 6; } }
:root[data-theme="dark"], [data-theme="dark"] { --canvas: 4 5 6; }
@media (prefers-reduced-motion: reduce) { :root { --duration-fast: 0s; } }
`);
});

test("drops the reset, element-wide variables and classes", () => {
  const css = `*,::before{--un-rotate:0;}
ol,ul,menu{list-style:none;margin:0;padding:0}
:root{--canvas:1 2 3;font-size:16px}
.text-sm{font-size:14px;}
@media (min-width: 640px){.sm\\:block{display:block;}}`;
  expect(designVariables(css)).toBe("\n");
});

test("design's own stylesheet gives the site its theme blocks and nothing else", () => {
  const blockHeads = designVariables(designCss)
    .split("\n")
    .filter((line) => /^\S.*\{$/.test(line));
  expect(blockHeads).toEqual([
    ":root {",
    "@media (prefers-color-scheme: dark) {",
    ':root[data-theme="dark"], [data-theme="dark"] {',
    ':root[data-theme="light"] {',
    ":root {",
    "@media (prefers-reduced-motion: reduce) {",
  ]);
});

test("a value with a character outside the BMP keeps the next block whole", () => {
  const css = ':root { --mark: "😀"; }\n:root { --canvas: 1 2 3; }';
  expect(designVariables(css)).toBe(':root { --mark: "😀"; }\n:root { --canvas: 1 2 3; }\n');
});
