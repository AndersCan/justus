// @vitest-environment happy-dom
import { describe, expect, test } from "vite-plus/test";
import { html, render } from "lit-html";
import { arrivalFocus, focusOnArrival } from "./arrival-focus";

const draw = (id: string) => {
  const host = document.createElement("div");
  document.body.append(host);
  render(html`<h1 tabindex="-1" ${arrivalFocus(id)}>Trip</h1>`, host);
  return host.querySelector("h1")!;
};

describe("arrival focus", () => {
  test("focuses the heading once for the pending album", async () => {
    focusOnArrival("a");
    const first = draw("a");
    await Promise.resolve();
    expect(document.activeElement).toBe(first);
    const field = document.createElement("input");
    document.body.append(field);
    field.focus();
    draw("a");
    await Promise.resolve();
    expect(document.activeElement).toBe(field);
  });

  test("ignores another album", async () => {
    focusOnArrival("a");
    const other = draw("b");
    await Promise.resolve();
    expect(document.activeElement).not.toBe(other);
    const mine = draw("a");
    await Promise.resolve();
    expect(mine).toBe(document.activeElement);
  });
});
