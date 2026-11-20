// @vitest-environment happy-dom
import { afterEach, expect, test } from "vite-plus/test";

import { confirmAction } from "./confirm";

const buttons = () =>
  [...document.querySelectorAll("[slot=footer] button")].map((b) => b.textContent?.trim());

afterEach(() => {
  document.body.innerHTML = "";
});

test("the back-out button says Keep by default", () => {
  void confirmAction({ title: "Leave?", confirmLabel: "Leave" });
  expect(buttons()).toEqual(["Keep", "Leave"]);
});

test("a cancelLabel replaces Keep", () => {
  void confirmAction({
    title: "Make Nils a Viewer?",
    confirmLabel: "Make Viewer",
    cancelLabel: "Keep as Collaborator",
  });
  expect(buttons()).toEqual(["Keep as Collaborator", "Make Viewer"]);
});

const twoFrames = () =>
  new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));

test("Keep has focus once the dialog is open, so Enter backs out", async () => {
  void confirmAction({ title: "Delete it?", confirmLabel: "Delete", tone: "danger" });
  await twoFrames();
  expect(document.activeElement?.textContent?.trim()).toBe("Keep");
});

test("a danger confirm is red, the default tone is the accent", () => {
  void confirmAction({ title: "Delete it?", confirmLabel: "Delete", tone: "danger" });
  void confirmAction({ title: "Make Nils a Viewer?", confirmLabel: "Make Viewer" });
  const confirmButtons = [...document.querySelectorAll("[slot=footer] button:last-child")];
  expect(
    confirmButtons.map((b) => [
      b.textContent?.trim(),
      b.classList.contains("bg-danger-fg"),
      b.classList.contains("bg-accent"),
    ]),
  ).toEqual([
    ["Delete", true, false],
    ["Make Viewer", false, true],
  ]);
});

test("Keep is described by the sheet's text and the confirm button by nothing", () => {
  void confirmAction({
    title: "Delete it?",
    detail: "It will be gone.",
    confirmLabel: "Delete",
    tone: "danger",
  });
  const [keep, confirm] = [...document.querySelectorAll("[slot=footer] button")];
  const id = keep?.getAttribute("aria-describedby") ?? "";
  expect(document.getElementById(id)?.textContent).toBe("It will be gone.");
  expect(confirm?.hasAttribute("aria-describedby")).toBe(false);
});

test("no detail, no description", () => {
  void confirmAction({ title: "Leave?", confirmLabel: "Leave" });
  expect(document.querySelector("[slot=footer] button")?.hasAttribute("aria-describedby")).toBe(
    false,
  );
});
