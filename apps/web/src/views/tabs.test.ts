// @vitest-environment happy-dom
import { render } from "lit-html";
import { expect, test } from "vite-plus/test";

import { tabs } from "./tabs";

test("only the current tab looks current and carries aria-current", () => {
  const root = document.createElement("div");
  render(
    tabs(
      "Sections",
      [
        { id: "a", label: "All", href: "#a" },
        { id: "b", label: "Albums", href: "#b" },
      ],
      "b",
    ),
    root,
  );
  const [first, second] = Array.from(root.querySelectorAll("a"));
  expect(second.className).toBe("ui-tab-selected");
  expect(second.getAttribute("aria-current")).toBe("page");
  expect(first.className).toBe("ui-tab");
  expect(first.getAttribute("aria-current")).not.toBe("page");
});
