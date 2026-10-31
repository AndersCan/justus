import { expect, test, type Page } from "@playwright/test";
import { openAlbum, pickPhotos, pngOf, runColour } from "./add-photos.js";

/**
 * Adding many photos at once: one pick inside an album, then a batch the
 * gallery adds one by one with progress and a single summary.
 */

const png = (name: string, salt: number) => ({
  name,
  mimeType: "image/png",
  buffer: pngOf(...runColour(salt)),
});

async function settle(page: Page) {
  const album = await openAlbum(page);
  return { album, before: await page.locator("figure img").count() };
}

test("picking several photos adds them all to the album on screen", async ({ page }) => {
  const { album, before } = await settle(page);

  await pickPhotos(page, [png("batch-1.png", 1), png("batch-2.png", 2), png("batch-3.png", 3)]);
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await expect(page.getByText(`Added 3 photos to ${album}`)).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("figure img")).toHaveCount(before + 3, { timeout: 20_000 });
  for (const name of ["batch-1.png", "batch-2.png", "batch-3.png"]) {
    const img = page.getByRole("button", { name: `View ${name}` }).locator("img");
    await expect
      .poll(() => img.evaluate((i: HTMLImageElement) => i.naturalWidth))
      .toBeGreaterThan(0);
  }
});

test("one photo that fails doesn't stop the rest, and can be retried", async ({ page }) => {
  const { before } = await settle(page);

  // An empty file is refused by the upload route; the good one still lands.
  await pickPhotos(page, [
    png("partial-ok.png", 4),
    { name: "partial-empty.png", mimeType: "image/png", buffer: Buffer.alloc(0) },
  ]);

  const alert = page.getByRole("alert").filter({ hasText: "couldn't be added" });
  await expect(alert).toContainText("1 photo couldn't be added. 1 added to", {
    timeout: 20_000,
  });
  await expect(alert).toContainText("partial-empty.png");
  await expect(page.locator("figure img")).toHaveCount(before + 1, { timeout: 20_000 });

  // Retry only re-sends the failed one (it fails again), then Dismiss clears it.
  await alert.getByRole("button", { name: "Retry" }).click();
  await expect(alert).toContainText("1 photo couldn't be added to", { timeout: 20_000 });
  await alert.getByRole("button", { name: "Dismiss" }).click();
  await expect(alert).toHaveCount(0);
  await expect(page.locator("figure img")).toHaveCount(before + 1);
});

test("dropping photos onto an album adds them there without asking", async ({ page }) => {
  const { album: name, before } = await settle(page);

  const bytes = [...pngOf(...runColour(5))];
  const transfer = await page.evaluateHandle((data) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(data)], "dropped.png", { type: "image/png" }));
    return dt;
  }, bytes);
  const target = page.getByRole("heading", { name: "Photos", level: 1 });
  await target.dispatchEvent("dragenter", { dataTransfer: transfer });
  await expect(page.getByText(`Drop to add to ${name}`)).toBeVisible();
  await target.dispatchEvent("dragover", { dataTransfer: transfer });
  await target.dispatchEvent("drop", { dataTransfer: transfer });

  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText(`Added a photo to ${name}`)).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("figure img")).toHaveCount(before + 1, { timeout: 20_000 });
  await expect(page.getByText(/^Drop to add/)).toHaveCount(0);
});
