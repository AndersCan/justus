import { expect, test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/** A real, decodable 64x64 JPEG — dropped into the dev inbox to test the
 * inbox → photos.add → push → live-gallery path. */
const TINY_JPEG =
  "/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAADaADAAQAAAABAAAACAAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgACAANAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwUDAwMFBgUFBQUGCAYGBgYGCAoICAgICAgKCgoKCgoKCgwMDAwMDA4ODg4ODw8PDw8PDw8PD//bAEMBAgICBAQEBwQEBxALCQsQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEP/dAAQAAf/aAAwDAQACEQMRAD8A9E+Hv7PRa3t2+z9VU9Pb6V9LN+z/AOTY237jru7fT2rtPh1/x6Wn+4n8hX0dd/8AHhZ/8D/9lrxeNfDDJ1UuqR+F/Rc8Ss3eGs6vT+up/9k=";

const INBOX = resolve(".dev-e2e/inbox");

/** All rendered photos must actually decode: complete + naturalWidth > 0.
 * This is the check that catches corrupt seed/import data (a 200 with a
 * JPEG header but undecodable pixels otherwise sails through every HTTP
 * assertion). */
async function expectAllImagesDecodable(page: import("@playwright/test").Page) {
  const images = page.locator("figure img");
  await expect(images.first()).toBeAttached({ timeout: 20_000 });
  await expect.poll(() => images.count()).toBeGreaterThan(0);
  const bad = await images.evaluateAll((els) =>
    els
      .map((el) => ({
        src: (el as HTMLImageElement).src,
        complete: (el as HTMLImageElement).complete,
        naturalWidth: (el as HTMLImageElement).naturalWidth,
      }))
      .filter((i) => !i.complete || i.naturalWidth === 0),
  );
  expect(bad, `undecodable images: ${JSON.stringify(bad, null, 2)}`).toEqual([]);
}

test("gallery loads seeded photos, all decodable, no console errors", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  await page.goto("/");

  // The seed writes at least 3 real photos (a previous test may have added
  // more via the inbox). Render once the gallery is ready.
  await expect(page.locator("figure img").first()).toBeAttached({ timeout: 20_000 });
  await expect
    .poll(async () => page.locator("figure img").count(), { timeout: 20_000 })
    .toBeGreaterThanOrEqual(3);
  await expectAllImagesDecodable(page);

  // The gallery must not be stuck in loading (the actor-wedge failure mode).
  await expect(page.getByText("Loading…")).toHaveCount(0, { timeout: 20_000 });
  await expect(page.getByText("No photos yet")).toHaveCount(0);

  expect(consoleErrors, `console errors:\n${consoleErrors.join("\n")}`).toEqual([]);
});

test("dropping a file into the dev inbox adds it to the gallery live", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("figure img").first()).toBeAttached({ timeout: 20_000 });
  const before = await page.locator("figure img").count();

  mkdirSync(INBOX, { recursive: true });
  writeFileSync(resolve(INBOX, `e2e-${Date.now()}.jpg`), Buffer.from(TINY_JPEG, "base64"));

  // The worklet's inbox watcher imports it and pushes photos.changed — the
  // gallery must grow by one without any user action.
  await expect
    .poll(async () => page.locator("figure img").count(), { timeout: 20_000 })
    .toBe(before + 1);
  await expectAllImagesDecodable(page);
});

test("picking several files at once adds them all to the gallery", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("figure img").first()).toBeAttached({ timeout: 20_000 });
  const before = await page.locator("figure img").count();

  // The hidden multi-file input is the 'Add photos' picker; Playwright drives
  // it directly with two real decodable JPEGs.
  const stamp = Date.now();
  await page.locator('input[type="file"]').setInputFiles([
    {
      name: `multi-a-${stamp}.jpg`,
      mimeType: "image/jpeg",
      buffer: Buffer.from(TINY_JPEG, "base64"),
    },
    {
      name: `multi-b-${stamp}.jpg`,
      mimeType: "image/jpeg",
      buffer: Buffer.from(TINY_JPEG, "base64"),
    },
  ]);

  await expect
    .poll(async () => page.locator("figure img").count(), { timeout: 20_000 })
    .toBe(before + 2);
  await expectAllImagesDecodable(page);
});

test("settings shows creator status", async ({ page }) => {
  await page.goto("/settings");
  await expect(page.getByText("creator", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Share key", { exact: true })).toBeVisible();
  await expect(page.getByText(/^Peers$/)).toBeVisible();
});
