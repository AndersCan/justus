// @vitest-environment happy-dom
import { render } from "lit-html";
import { expect, test } from "vite-plus/test";

import { wordmark } from "./wordmark";

test("the animated wordmark's dots meet a few times and rest; it never animates forever", () => {
  const host = document.createElement("div");
  render(wordmark("h-14", true), host);
  const animations = [...host.querySelectorAll("animate")];
  expect(animations).toHaveLength(2);
  for (const a of animations) {
    expect(a.getAttribute("repeatDur")).toBe("6.48s");
    expect(a.getAttribute("fill")).toBe("freeze");
  }
  render(wordmark("h-14"), host);
  expect(host.querySelectorAll("animate")).toHaveLength(0);
  render(null, host);
});
