import { expect, test } from "@playwright/test";

/**
 * Photos is where you look; Sharing is where you manage. An album created in
 * Sharing opens in Photos, the All tab keeps showing every photo, and the
 * Albums tab narrows the grid to one album. Ends on the seed album so later
 * specs add photos there.
 */
test("a new album opens in Photos; All shows every photo; Albums narrows to one", async ({
  page,
}) => {
  // Settle on the gallery first, then navigate in-app (one socket for the test).
  await page.goto("/");
  await expect(page.locator("figure img").first()).toBeAttached({ timeout: 20_000 });
  const total = await page.locator("figure img").count();

  await page
    .getByRole("navigation", { name: "Main" })
    .first()
    .getByRole("link", { name: "Sharing" })
    .click();
  await expect(page.getByRole("heading", { name: "Sharing", exact: true })).toBeVisible();
  const list = page.getByRole("list", { name: "Your albums" });
  await expect(list.getByRole("listitem")).toHaveCount(1, { timeout: 20_000 });
  await expect(list.getByText(/Admin · 1 member/)).toBeVisible();
  const seedName = (
    await list.locator('a[aria-label^="Invite & members of "] span').first().innerText()
  ).trim();

  await page.getByLabel("Album name").fill("Trip 2026");
  await page.getByRole("button", { name: "Create album" }).click();

  await expect(page).toHaveURL(/\/albums\/[^/]+$/, { timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "Trip 2026" })).toBeVisible({ timeout: 20_000 });
  // The e2e worklet seeds sample photos into every new album.
  await expect(page.locator("figure img").first()).toBeAttached({ timeout: 20_000 });
  const inTrip = await page.locator("figure img").count();

  const views = page.getByRole("navigation", { name: "Show photos" });
  await views.getByRole("link", { name: "All", exact: true }).click();
  await expect(page.locator("figure img")).toHaveCount(total + inTrip, { timeout: 20_000 });

  await views.getByRole("link", { name: "Added by me" }).click();
  await expect(page.locator("figure img").first()).toBeAttached({ timeout: 20_000 });

  await views.getByRole("link", { name: "Albums" }).click();
  const albums = page.getByRole("list", { name: "Albums" });
  await expect(albums.getByRole("link", { name: `Trip 2026, ${inTrip} photos` })).toBeVisible();
  await albums.getByRole("link", { name: new RegExp(`^${seedName}, `) }).click();
  await expect(page.getByRole("heading", { name: seedName })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("figure img")).toHaveCount(total, { timeout: 20_000 });
});

test("New album in Photos names the album in place and opens it", async ({ page }) => {
  await page.goto("/albums");
  await page.getByRole("button", { name: "New album" }).click();
  const sheet = page.getByRole("dialog", { name: "Start an album" });
  await sheet.getByLabel("Album name").fill("Garden");
  await sheet.getByRole("button", { name: "Create album" }).click();

  await expect(page).toHaveURL(/\/albums\/[^/]+$/, { timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "Garden" })).toBeVisible({ timeout: 20_000 });
});
