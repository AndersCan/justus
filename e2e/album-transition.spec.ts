import { expect, test } from "@playwright/test";

/**
 * An album card grows into its page and the page shrinks back on Back. Wraps
 * document.startViewTransition to count calls and the named elements at each.
 */
test("the album card grows into its page and shrinks back; Reduce motion has no transition", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const w = window as any;
    w.__vt = [];
    const real = document.startViewTransition?.bind(document);
    if (!real) return;
    document.startViewTransition = ((cb: () => void) => {
      w.__vt.push(document.querySelectorAll('[data-vt="album"]').length);
      return real(cb);
    }) as never;
  });
  const calls = () => page.evaluate(() => (window as any).__vt as number[]);

  await page.goto("/albums");
  const card = page.locator("[data-album-card]").first();
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.click();
  await expect(page).toHaveURL(/\/albums\/[^/]+$/);
  await expect(page.getByRole("link", { name: "All albums" })).toBeVisible();
  expect(await calls()).toEqual([1]);

  await page.getByRole("link", { name: "All albums" }).click();
  await expect(page).toHaveURL(/\/albums$/);
  await expect(card).toBeVisible();
  expect(await calls()).toEqual([1, 1]);
  await expect(page.locator("[data-album-card][data-vt]")).toHaveCount(0);

  await page.goBack();
  await expect(page).not.toHaveURL(/\/albums\/[^/]+$/);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/albums");
  await page.locator("[data-album-card]").first().click();
  await expect(page.getByRole("link", { name: "All albums" })).toBeVisible();
  await page.getByRole("link", { name: "All albums" }).click();
  await expect(page).toHaveURL(/\/albums$/);
  expect(await calls()).toEqual([]);
});

test("Back right after tapping an album lands on the grid", async ({ page }) => {
  await page.goto("/albums");
  const card = page.locator("[data-album-card]").first();
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.click();
  await page.evaluate(() => history.back());
  await expect(page).toHaveURL(/\/albums$/);
  await page.waitForTimeout(1500);
  await expect(page.getByRole("link", { name: "All albums" })).toHaveCount(0);
  await expect(page.locator("[data-album-card]").first()).toBeVisible();
});
