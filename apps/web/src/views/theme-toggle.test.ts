// @vitest-environment happy-dom
import { render } from "lit-html";
import { expect, test } from "vite-plus/test";

import { prefs } from "../machines/prefs-machine";
import { densitySetting, themeSetting } from "./theme-toggle";

const cards = (host: HTMLElement) =>
  Object.fromEntries(
    [...host.querySelectorAll("[role=radio]")].map((b) => [b.textContent?.trim(), b.className]),
  );

test("only the chosen theme card looks chosen", () => {
  prefs.setTheme("dark");
  const host = document.createElement("div");
  render(themeSetting(), host);
  expect(cards(host)).toEqual({
    Auto: "ui-radio-card",
    Light: "ui-radio-card",
    Dark: "ui-radio-card-checked",
  });
  render(null, host);
});

test("only the chosen photo grid card looks chosen", () => {
  prefs.setDensity("compact");
  const host = document.createElement("div");
  render(densitySetting(), host);
  expect(cards(host)).toEqual({ Comfortable: "ui-radio-card", Compact: "ui-radio-card-checked" });
  render(null, host);
});
