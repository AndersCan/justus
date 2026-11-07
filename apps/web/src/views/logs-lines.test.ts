// @vitest-environment happy-dom
import { describe, it, expect } from "vite-plus/test";
import { render } from "lit-html";
import type { LogEntry } from "@justus/core";
import { logLines } from "./logs";

const line = (n: number): LogEntry => ({
  seq: n,
  ts: 1_700_000_000_000 + n,
  level: "info",
  source: "web",
  message: `message ${n}`,
});

function rows(root: HTMLElement): Map<string, HTMLElement> {
  const out = new Map<string, HTMLElement>();
  for (const el of root.querySelectorAll<HTMLElement>("[data-log-key]")) {
    out.set(el.dataset.logKey ?? "", el);
  }
  return out;
}

const key = (n: number) => `${n}:${1_700_000_000_000 + n}`;
const copies = (ns: number[]) => ns.map((n) => ({ ...line(n) }));

describe("logLines", () => {
  it("a new line adds one row and leaves the others alone", () => {
    const root = document.createElement("div");
    render(logLines(copies([1, 2, 3])), root);
    const before = rows(root).get(key(2));
    const textNode = before?.lastChild;
    const text = textNode?.textContent;
    render(logLines(copies([1, 2, 3, 4])), root);
    const after = rows(root);
    expect(after.size).toBe(4);
    expect(after.get(key(2))).toBe(before);
    expect(after.get(key(2))?.lastChild).toBe(textNode);
    expect(textNode?.textContent).toBe(text);
    expect(root.querySelector("[data-log-key]")?.getAttribute("data-log-key")).toBe(key(4));
  });

  it("drops only the oldest row at the cap", () => {
    const root = document.createElement("div");
    render(logLines(copies([1, 2, 3, 4])), root);
    const before = rows(root);
    render(logLines(copies([2, 3, 4])), root);
    const after = rows(root);
    expect(after.has(key(1))).toBe(false);
    for (const n of [2, 3, 4]) expect(after.get(key(n))).toBe(before.get(key(n)));
  });

  it("keeps surviving rows when a filter hides some", () => {
    const root = document.createElement("div");
    render(logLines(copies([1, 2, 3, 4])), root);
    const before = rows(root);
    render(logLines(copies([2, 4])), root);
    const after = rows(root);
    expect(after.size).toBe(2);
    expect(after.get(key(2))).toBe(before.get(key(2)));
    expect(after.get(key(4))).toBe(before.get(key(4)));
  });

  it("marks each row for the fade-in", () => {
    const root = document.createElement("div");
    render(logLines(copies([1, 2])), root);
    expect(root.querySelectorAll(".justus-log-line")).toHaveLength(2);
  });
});
