import { expect, test } from "@playwright/test";

// A fresh install: no welcome-seen flag, so "/" lands on the intro. A phone that already has an
// album skips the intro, so this file runs on the worklet with no sample album (playwright.config.ts,
// "first-run" project; scripts/e2e-server.mjs). The test that creates an album stays last.
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

  await expect(
    page.getByRole("heading", { name: "Photos go straight to your friends" }),
  ).toBeVisible();
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

test("two cards, no Skip on the last, Back returns to the card left", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Photos go straight to your friends" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Skip" })).toBeVisible();
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByRole("heading", { name: "You decide who joins" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Skip" })).toHaveCount(0);

  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByLabel("Your name")).toBeVisible();
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByRole("heading", { name: "You decide who joins" })).toBeVisible();

  await page.getByRole("button", { name: "Back" }).click();
  await expect(
    page.getByRole("heading", { name: "Photos go straight to your friends" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Skip" }).click();
  await page.getByRole("button", { name: "Back" }).click();
  await expect(
    page.getByRole("heading", { name: "Photos go straight to your friends" }),
  ).toBeVisible();
});

test("the tabs stay hidden until the name is saved", async ({ page }) => {
  const tabs = page.getByRole("navigation", { name: "Main" });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Photos go straight to your friends" }),
  ).toBeVisible();
  await expect(tabs).toHaveCount(0);
  await page.getByRole("button", { name: "Skip" }).click();
  await expect(page.getByLabel("Your name")).toBeVisible();
  await expect(tabs).toHaveCount(0);
  await page.getByLabel("Your name").fill("Robin Park");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Start sharing" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(tabs.getByRole("link", { name: "Photos" })).toBeVisible();
});

test("an invite link opened before the welcome asks once the name is saved", async ({ page }) => {
  const code = "a".repeat(64);
  const owner = "b".repeat(64);
  await page.goto(`/join?i=${code}&o=${owner}&n=Garden&a=Tom`);
  await expect(page).toHaveURL(/\/welcome$/);
  await page.getByRole("button", { name: "Skip" }).click();
  await page.getByLabel("Your name").fill("Joe");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("dialog", { name: "Ask to join “Garden”?" })).toBeVisible({
    timeout: 20_000,
  });
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
