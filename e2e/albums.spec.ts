import { expect, test } from "@playwright/test";

/**
 * A user keeps several albums, each with its own people and invite. The Albums
 * tab lists them; creating one opens it in Photos, and the Photos heading then
 * offers a switch between them. Switches back so later specs see the seed album.
 */
test("albums tab lists albums; a new album opens in Photos and can be switched", async ({
  page,
}) => {
  // Settle on the gallery first, then navigate in-app (one socket for the test).
  await page.goto("/");
  await expect(page.locator("figure img").first()).toBeAttached({ timeout: 20_000 });
  await page
    .getByRole("navigation", { name: "Main" })
    .first()
    .getByRole("link", { name: "Albums" })
    .click();
  await expect(page.getByRole("heading", { name: "Albums", exact: true })).toBeVisible();
  const list = page.getByRole("list", { name: "Your albums" });
  await expect(list.getByRole("listitem")).toHaveCount(1, { timeout: 20_000 });
  await expect(list.getByText(/Admin · 1 member/)).toBeVisible();
  const seedName = (await list.getByRole("listitem").locator("span.truncate").innerText()).trim();

  await page.getByLabel("Album name").fill("Trip 2026");
  await page.getByRole("button", { name: "Create album" }).click();

  await expect(page).toHaveURL(/\/$/, { timeout: 20_000 });
  await expect(page.getByRole("heading", { level: 1, name: "Trip 2026" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByRole("link", { name: "All 2 albums" })).toBeVisible();

  await page.getByLabel("Switch album").selectOption({ label: seedName });
  await expect(page.getByRole("heading", { level: 1, name: seedName })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.locator("figure img").first()).toBeAttached({ timeout: 20_000 });

  await page.getByRole("link", { name: "All 2 albums" }).click();
  await expect(list.getByRole("listitem")).toHaveCount(2);
});
