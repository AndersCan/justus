import { expect, test } from "@playwright/test";

// A fresh install: no welcome-seen flag, so "/" lands on the intro.
test.use({ storageState: { cookies: [], origins: [] } });

/**
 * First run: the intro cards, the profile step, then the create-or-join
 * choice. Saving the name re-renders the avatar preview; it once threw inside
 * the save transition, killing the onboarding actor and leaving "Saving…" up
 * for good.
 */
test("the intro saves the name and moves on to the choice", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/welcome$/);

  await page.getByRole("button", { name: "Skip" }).click();
  const name = page.getByLabel("Your name");
  const preview = page.locator("[data-avatar] span");
  await name.fill("");
  await name.pressSequentially("Robin Park");
  await expect(preview).toHaveText("RP");

  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Start sharing" })).toBeVisible({
    timeout: 20_000,
  });
  expect(await page.evaluate(() => localStorage.getItem("justus:welcome-seen"))).toBe("1");
});

/** Creating the first album lands inside it, where its add button names it,
 * not on "All", where it would be unclear which album photos go to. */
test("creating the first album opens it", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Skip" }).click();
  await page.getByLabel("Your name").fill("Robin Park");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Start sharing" })).toBeVisible({
    timeout: 20_000,
  });

  await page.getByLabel("Album name").fill("Summer");
  await page.getByRole("button", { name: "Create an album" }).click();
  await expect(page).toHaveURL(/\/albums\/[^/]+$/, { timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Add photos to Summer" })).toBeVisible();
});
