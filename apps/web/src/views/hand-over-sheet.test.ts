// @vitest-environment happy-dom
import { afterEach, expect, test } from "vite-plus/test";

import { chooseNewAdmin } from "./hand-over-sheet";

afterEach(() => {
  document.body.innerHTML = "";
});

const choices = [
  { key: "b", name: "Ben" },
  { key: "c", name: "Cy" },
];

test("one button per Collaborator, each saying they can add photos now", () => {
  void chooseNewAdmin("Summer", choices);
  const buttons = [...document.querySelectorAll("[data-new-admin]")];
  expect(buttons.map((b) => b.textContent?.replace(/\s+/g, " ").trim())).toEqual([
    "Ben Can add photos now",
    "Cy Can add photos now",
  ]);
  expect(document.querySelector("h3")?.textContent?.trim()).toBe("Who takes over Summer?");
});

test("tapping a person resolves their key", async () => {
  const picked = chooseNewAdmin("Summer", choices);
  document.querySelector<HTMLElement>("[data-new-admin=c]")?.click();
  document.querySelector("wa-dialog")?.dispatchEvent(new Event("wa-after-hide"));
  expect(await picked).toBe("c");
});

test("Close resolves nothing", async () => {
  const picked = chooseNewAdmin("Summer", choices);
  document.querySelector<HTMLElement>("[data-dismiss]")?.click();
  document.querySelector("wa-dialog")?.dispatchEvent(new Event("wa-after-hide"));
  expect(await picked).toBeNull();
});
