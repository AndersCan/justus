import { expect, test } from "@playwright/test";

test("Restore on an archived album's page puts focus back on More options", async ({ page }) => {
  await page.goto("/albums");
  await page.getByRole("button", { name: "New album" }).click();
  const sheet = page.getByRole("dialog", { name: "Start an album" });
  await sheet.getByLabel("Album name").fill("Restore focus");
  await sheet.getByRole("button", { name: "Create album" }).click();
  await expect(page.getByRole("heading", { name: "Restore focus" })).toBeVisible({
    timeout: 20_000,
  });
  await page.getByRole("link", { name: "Invite & members" }).click();
  const url = page.url();
  const more = page.getByRole("button", { name: "More options" });
  await more.click();
  await page.getByRole("menuitem", { name: "Archive" }).click();
  await expect(page).toHaveURL(/\/sharing$/, { timeout: 20_000 });
  await page.goto(url);
  await page.getByRole("button", { name: "Open album" }).click();
  await more.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menuitem")).toHaveText(["Restore"]);
  await expect(page.getByRole("menuitem", { name: "Restore" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Add photos" })).toBeVisible();
  await expect
    .poll(
      () =>
        page.evaluate(
          () => document.activeElement === document.querySelector('[aria-label="More options"]'),
        ),
      { timeout: 3000 },
    )
    .toBe(true);
});
