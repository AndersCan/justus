import { expect, test } from "@playwright/test";
import { pngOf, runColour } from "./add-photos.js";
import { words } from "./p2p/steps.js";

/**
 * Ada picks 5 photos on Photos > All, chooses an album in the sheet, and they
 * land there in the order she picked them.
 */
test("Ada adds 5 photos from All into a chosen album, in picked order", async ({ page }) => {
  const album = `Picked ${Date.now() % 100000}`;
  await page.goto("/albums");
  await page.getByRole("button", { name: words("gallery.new_album") }).click();
  const start = page.getByRole("dialog", { name: words("start_album.start_an_album") });
  await start.getByLabel(words("start_album.album_name")).fill(album);
  await start.getByRole("button", { name: words("gallery.create_album") }).click();
  await expect(page).toHaveURL(/\/albums\/[^/]+$/, { timeout: 20_000 });
  const albumUrl = new URL(page.url()).pathname;

  await page.goto("/");
  await expect(page.locator("figure img").first()).toBeAttached({ timeout: 20_000 });
  const add = page.getByRole("button", { name: words("gallery.add_photos"), exact: true });
  await expect(add).toBeVisible();

  const order = ["pick-3.png", "pick-1.png", "pick-5.png", "pick-2.png", "pick-4.png"];
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), add.click()]);
  expect(chooser.isMultiple()).toBe(true);
  await chooser.setFiles(
    order.map((name, i) => ({
      name,
      mimeType: "image/png",
      buffer: pngOf(...runColour(90 + i)),
    })),
  );

  const sheet = page.getByRole("dialog", {
    name: words("share_to_album.add_photos_to", { count: 5 }),
  });
  await expect(sheet).toBeVisible();
  await sheet
    .getByRole("button", {
      name: words("share_to_album.add_photos_to_album", { count: 5, name: album }),
    })
    .click();
  await expect(sheet).toBeHidden();

  expect(new URL(page.url()).pathname).toBe("/");
  const toast = page.locator(".justus-toast", {
    hasText: words("add_photos.added_photos_to", { added: 5, album }),
  });
  await expect(toast).toBeVisible({ timeout: 60_000 });
  const views = order.map((name) => words("gallery.view", { name }));
  const tiles = page.locator("[data-photo-tile]");
  await expect(tiles.nth(4)).toBeAttached();
  expect(await tiles.evaluateAll((els) => els.slice(0, 5).map((e) => e.ariaLabel))).toEqual(views);

  await toast.getByRole("button", { name: words("add_photos.open_album", { album }) }).click();
  await expect(page).toHaveURL((u) => u.pathname === albumUrl);
  await expect(page.getByRole("heading", { name: album })).toBeVisible({ timeout: 20_000 });
  await expect(tiles.nth(4)).toBeAttached({ timeout: 20_000 });
  expect(await tiles.evaluateAll((els) => els.slice(0, 5).map((e) => e.ariaLabel))).toEqual(views);

  // Archive it: albums.spec, next in order, counts one album and the seed photos on All.
  await page.getByRole("link", { name: words("gallery.invite_members") }).click();
  await page.getByRole("button", { name: words("album.more_options") }).click();
  await page.getByRole("menuitem", { name: words("album.archive") }).click();
  await expect(page).toHaveURL(/\/sharing$/, { timeout: 20_000 });
});
