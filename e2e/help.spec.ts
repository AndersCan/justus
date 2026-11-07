import { expect, test } from "@playwright/test";

/** Help is a row in Settings, not a tab in the main nav. */
test("Help is reached from Settings, not the main nav", async ({ page }) => {
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Main" }).first();
  await expect(nav.getByRole("link")).toHaveCount(3);
  await expect(nav.getByRole("link", { name: "Help" })).toHaveCount(0);

  await nav.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("link", { name: "Help" }).click();
  await expect(page.getByRole("heading", { name: "Help", exact: true })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Settings" })).toHaveAttribute("aria-current", "page");

  await page.getByRole("link", { name: "← Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
});
