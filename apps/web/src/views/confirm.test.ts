// @vitest-environment happy-dom
import { afterEach, expect, test } from "vite-plus/test";

import { confirmAction } from "./confirm";

const buttons = () => [...document.querySelectorAll("wa-button")].map((b) => b.textContent?.trim());

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
