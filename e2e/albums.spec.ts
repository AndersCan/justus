import { expect, test } from "@playwright/test";
import { pickPhotos, pngOf, runColour } from "./add-photos.js";

/**
 * Photos is where you look; Sharing is where you manage. An album created in
 * Sharing opens on its Invite & members page, See photos opens it in Photos, the All tab keeps showing every photo, and the
 * Albums tab narrows the grid to one album. Ends on the seed album so later
 * specs add photos there.
 */
test("a new album made in Sharing opens its invite page; All shows every photo; Albums narrows to one", async ({
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
  await page.evaluate(() => {
    const w = window as any;
    w.__sawFallback = false;
    new MutationObserver(() => {
      if (document.body.innerText.includes("This album isn't showing right now")) {
        w.__sawFallback = true;
      }
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  await page.getByRole("button", { name: "Create album" }).click();

  await expect(page).toHaveURL(/\/sharing\/[^/]+$/, { timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "Trip 2026", level: 1 })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByRole("link", { name: "See photos in this album" })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__sawFallback)).toBe(false);
  await expect(page.getByRole("button", { name: "Add photos" })).toBeVisible();
  await pickPhotos(page, {
    name: "trip.png",
    mimeType: "image/png",
    buffer: pngOf(...runColour(3)),
  });
  await expect(page).toHaveURL(/\/albums\/[^/]+$/, { timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "Trip 2026" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Added a photo to Trip 2026")).toBeVisible({ timeout: 20_000 });
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

test("reloading an album or its Invite & members page shows it again", async ({ page }) => {
  const missing: string[] = [];
  page.on("response", (r) => {
    const url = new URL(r.url());
    if (
      r.status() === 404 &&
      url.origin === "http://127.0.0.1:8090" &&
      /\.(js|css|svg)$/.test(url.pathname)
    ) {
      missing.push(url.pathname);
    }
  });
  await page.goto("/albums");
  await page.getByRole("list", { name: "Albums" }).getByRole("link").first().click();
  await expect(page).toHaveURL(/\/albums\/[^/]+$/, { timeout: 20_000 });
  const name = page.locator('[data-motion-key="section:album"] h2');
  await expect(name).toBeVisible({ timeout: 20_000 });
  const albumName = (await name.innerText()).trim();

  await page.reload();
  await expect(page.getByRole("heading", { name: albumName })).toBeVisible({ timeout: 20_000 });

  await page.getByRole("link", { name: /Invite & members/ }).click();
  await expect(page).toHaveURL(/\/sharing\/[^/]+$/, { timeout: 20_000 });
  await expect(page.getByRole("heading", { name: albumName, level: 1 })).toBeVisible({
    timeout: 20_000,
  });

  await page.reload();
  await expect(page.getByRole("heading", { name: albumName, level: 1 })).toBeVisible({
    timeout: 20_000,
  });
  expect(missing).toEqual([]);
});

test("Archive from the album page lands on Sharing with the album under Archived and Undo", async ({
  page,
}) => {
  await page.goto("/albums");
  await page.getByRole("button", { name: "New album" }).click();
  const sheet = page.getByRole("dialog", { name: "Start an album" });
  await sheet.getByLabel("Album name").fill("Summer trip");
  await sheet.getByRole("button", { name: "Create album" }).click();
  await expect(page.getByRole("heading", { name: "Summer trip" })).toBeVisible({
    timeout: 20_000,
  });

  await page.getByRole("link", { name: "Invite & members" }).click();
  await page.getByRole("button", { name: "More options" }).click();
  await page.getByRole("menuitem", { name: "Archive" }).click();

  await expect(page).toHaveURL(/\/sharing$/, { timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "Sharing", exact: true })).toBeVisible();
  await expect(page.getByText(/Archived \(\d+\)/)).toBeVisible();
  await page.getByText(/Archived \(\d+\)/).click();
  await expect(
    page.getByRole("list", { name: "Archived albums" }).getByText("Summer trip"),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Undo" })).toBeVisible();

  await page.goBack();
  await page
    .getByRole("navigation", { name: "Main" })
    .first()
    .getByRole("link", { name: "Sharing" })
    .click();
  await expect(page.getByRole("heading", { name: "Sharing", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByRole("link", { name: "Invite & members of Summer trip" })).toBeVisible();
});
