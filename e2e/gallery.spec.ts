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
 * assertion). Images are lazy-loaded and decode asynchronously, so poll until
 * every one is decodable instead of asserting a single snapshot. */
async function expectAllImagesDecodable(page: import("@playwright/test").Page) {
  const images = page.locator("figure img");
  await expect(images.first()).toBeAttached({ timeout: 20_000 });
  await expect.poll(() => images.count(), { timeout: 20_000 }).toBeGreaterThan(0);
  await expect
    .poll(
      async () => {
        // Images are lazy-loaded: scroll every one into view so below-fold
        // photos start decoding, then report the still-undecodable ones.
        await images.evaluateAll((els) =>
          els.forEach((el) => (el as Element).scrollIntoView({ block: "nearest" })),
        );
        return images.evaluateAll((els) =>
          els
            .map((el) => ({
              src: (el as HTMLImageElement).src,
              complete: (el as HTMLImageElement).complete,
              naturalWidth: (el as HTMLImageElement).naturalWidth,
            }))
            .filter((i) => !i.complete || i.naturalWidth === 0),
        );
      },
      { timeout: 20_000 },
    )
    .toEqual([]);
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

test("picking a photo in the browser uploads it to the worklet route and adds it live", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("figure img").first()).toBeAttached({ timeout: 20_000 });
  const before = await page.locator("figure img").count();

  // The gallery's Pick button is a hidden file input; setting files exercises
  // the browser → worklet `POST /photos` route → store.add → push path with a
  // real chosen file (same-origin, exactly like the WebView on device).
  // Distinct bytes from the inbox test above: since #20's sha256 ingest
  // dedupe, identical content no longer grows the gallery twice.
  await page.setInputFiles("input[type=file]", {
    name: `picked-${Date.now()}.png`,
    mimeType: "image/png",
    buffer: Buffer.from(TINY_PNG_B, "base64"),
  });

  await expect
    .poll(async () => page.locator("figure img").count(), { timeout: 20_000 })
    .toBe(before + 1);
  await expectAllImagesDecodable(page);
});

/** A real, decodable 1x1 PNG (distinct from the JPEG used by the inbox and
 * seed paths, so dedupe tests can isolate their own content). */
const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** A distinct 1x1 PNG (red pixel) used by the picker test so it does not collide
 * with TINY_PNG, which the dedupe test relies on being novel within a run. */
const TINY_PNG_B =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

test("adding identical bytes twice is deduped to one entry (#20)", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("figure img").first()).toBeAttached({ timeout: 20_000 });
  const before = await page.locator("figure img").count();

  const uploadOnce = () =>
    Promise.all([
      page.waitForResponse((r) => r.url().includes("/photos") && r.request().method() === "POST"),
      page.setInputFiles("input[type=file]", {
        name: "dedupe-probe.png",
        mimeType: "image/png",
        buffer: Buffer.from(TINY_PNG, "base64"),
      }),
    ]);

  const [res1] = await uploadOnce();
  const firstId = ((await res1.json()) as { id?: string }).id;
  expect(firstId).toBeTruthy();

  // Same bytes again: the ingest boundary must recognize the content and
  // return the SAME entry instead of creating a second one.
  const [res2] = await uploadOnce();
  const secondId = ((await res2.json()) as { id?: string }).id;
  expect(secondId).toBe(firstId);

  // And the derived gallery must not have grown.
  await page.waitForTimeout(1_000);
  expect(await page.locator("figure img").count()).toBe(before + 1);
});

test("settings has profile and appearance, and no album tools", async ({ page }) => {
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Profile" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "Appearance" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "Dark" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Your albums/ })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Active album" })).toHaveCount(0);
});

test("the Compact grid setting shrinks the photo tiles", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const nav = page.getByRole("navigation", { name: "Main" }).last();
  // Navigate in-app (no reload), the way a user switches tabs.
  const tileWidth = async () => {
    await nav.getByRole("link", { name: "Photos" }).click();
    const tile = page.locator("figure").first();
    await expect(tile).toBeVisible({ timeout: 20_000 });
    return (await tile.boundingBox())!.width;
  };
  const pick = async (label: string) => {
    await nav.getByRole("link", { name: "Settings" }).click();
    await page.getByRole("radio", { name: label }).click();
    await expect(page.getByRole("radio", { name: label })).toHaveAttribute("aria-checked", "true");
  };

  await page.goto("/");
  await pick("Comfortable");
  const comfortable = await tileWidth();
  await pick("Compact");
  const compact = await tileWidth();
  expect(compact).toBeLessThan(comfortable * 0.8);
});

test("an album page shows members and keeps the invite behind a confirmation", async ({ page }) => {
  await page.goto("/sharing");
  await page
    .getByRole("link", { name: /^Manage / })
    .first()
    .click();
  await expect(page.getByRole("heading", { name: "Members" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Copy invite link" })).toHaveCount(0);
  await page.getByRole("button", { name: "Show invite…" }).click();
  await page.getByRole("button", { name: "Show invite", exact: true }).click();
  await expect(page.getByRole("button", { name: "Copy invite link" })).toBeVisible();
});

test("tapping a photo opens the lightbox; Escape closes it; remove asks for confirmation", async ({
  page,
}) => {
  await page.goto("/");
  const first = page.locator("figure").first();
  await expect(first).toBeAttached({ timeout: 20_000 });

  // Open the lightbox from the tile.
  await first.click();
  const close = page.getByRole("button", { name: "Close" });
  await expect(close).toBeVisible({ timeout: 5_000 });
  await expect(page.getByRole("button", { name: "Remove", exact: true })).toBeVisible();

  // Esc closes it.
  await page.keyboard.press("Escape");
  await expect(close).toHaveCount(0, { timeout: 5_000 });

  // Remove requires the confirmation sheet, and "Keep" leaves the photo alone.
  const tileName = await first.getAttribute("aria-label");
  await page.locator('button[aria-label^="Remove"]').first().click();
  await expect(page.getByRole("dialog")).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText(/Remove “.+”?/)).toBeVisible();
  await page.getByRole("button", { name: "Keep" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 5_000 });
  await expect(page.locator("figure img").first()).toBeAttached({ timeout: 5_000 });
  await expect(page.locator(`figure[aria-label="${tileName}"]`)).toHaveCount(1);
});
