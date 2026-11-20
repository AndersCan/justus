// @vitest-environment happy-dom
import { expect, test } from "vite-plus/test";
import { toast } from "./toast";

test("the host is on the page, empty, as a polite status line before any toast", () => {
  const host = document.querySelector("[data-toast-host]");
  expect(host?.getAttribute("role")).toBe("status");
  expect(host?.getAttribute("aria-atomic")).toBe("false");
  expect(host?.textContent?.trim()).toBe("");
});

test("a toast is a plain child of the host", () => {
  toast("Deleted “b”.");
  const host = document.querySelector("[data-toast-host]");
  expect(host?.querySelector(".justus-toast")?.textContent).toContain("Deleted “b”.");
  expect(host?.querySelectorAll("[role],[aria-live]").length).toBe(0);
});
