import { expect, test, type Page } from "@playwright/test";
import { pickPhotos, pngOf, runColour } from "./add-photos.js";

/**
 * Adding many photos at once: one pick, one album question, then a batch the
 * gallery adds one by one with progress and a single summary. Runs after
 * albums.spec, so the All tab has two albums and asks which one.
 */

const png = (name: string, salt: number) => ({
  name,
  mimeType: "image/png",
  buffer: pngOf(...runColour(salt)),
});

async function settle(page: Page) {
  await page.goto("/");
  await expect(page.locator("figure img").first()).toBeAttached({ timeout: 20_000 });
  return page.locator("figure img").count();
}

test("picking several photos adds them all after one album question", async ({ page }) => {
  const before = await settle(page);

  await page.setInputFiles("input[type=file]", [
    png("batch-1.png", 1),
    png("batch-2.png", 2),
    png("batch-3.png", 3),
  ]);
  const sheet = page.getByRole("dialog", { name: "Add 3 photos to which album?" });
  await expect(sheet).toBeVisible();
  const album = (
    await sheet.getByRole("button").first().locator("span").first().innerText()
  ).trim();
  await sheet.getByRole("button").first().click();

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
  const before = await settle(page);

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
  await settle(page);
  const albums = page.getByRole("navigation", { name: "Show photos" });
  await albums.getByRole("link", { name: "Albums" }).click();
  await page.getByRole("list", { name: "Albums" }).getByRole("link").first().click();
  await expect(page).toHaveURL(/\/albums\/[^/]+$/);
  const name = (await page.getByRole("heading", { level: 2 }).first().innerText()).trim();
  await expect(page.locator("figure img").first()).toBeAttached({ timeout: 20_000 });
  const before = await page.locator("figure img").count();

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
