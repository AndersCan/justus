import { expect, test } from "@playwright/test";
import { openAlbum, pickPhotos } from "./add-photos.js";

/** A minimal decodable 1x1 baseline JPEG. */
const BASE_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k=",
  "base64",
);

/** A JPEG whose EXIF says it was taken on 1998-07-04: an Exif APP1 segment
 * (TIFF → Exif IFD → DateTimeOriginal) spliced in right after SOI. */
function jpegTakenIn1998(): Buffer {
  const date = Buffer.from("1998:07:04 12:00:00\0", "latin1");
  const tiff = Buffer.alloc(8 + 18 + 18 + date.length);
  tiff.write("II", 0, "latin1");
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8); // IFD0: one entry, the Exif IFD pointer
  tiff.writeUInt16LE(0x8769, 10);
  tiff.writeUInt16LE(4, 12);
  tiff.writeUInt32LE(1, 14);
  tiff.writeUInt32LE(26, 18);
  tiff.writeUInt16LE(1, 26); // Exif IFD: DateTimeOriginal
  tiff.writeUInt16LE(0x9003, 28);
  tiff.writeUInt16LE(2, 30);
  tiff.writeUInt32LE(date.length, 32);
  tiff.writeUInt32LE(44, 36);
  date.copy(tiff, 44);
  const body = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const app1 = Buffer.from([0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 0xff]);
  return Buffer.concat([BASE_JPEG.subarray(0, 2), app1, body, BASE_JPEG.subarray(2)]);
}

test("photos sort by date added or by the date taken in their EXIF", async ({ page }) => {
  await openAlbum(page);
  const before = await page.locator("figure img").count();

  await pickPhotos(page, {
    name: "fireworks-1998.jpg",
    mimeType: "image/jpeg",
    buffer: jpegTakenIn1998(),
  });
  await expect(page.locator("figure img")).toHaveCount(before + 1, { timeout: 20_000 });
  const tile = page.getByRole("button", { name: "View fireworks-1998.jpg" });

  // Date added: it was just added, so it leads under "Recently added".
  const sort = page.getByRole("radiogroup", { name: "Sort by" });
  await sort.getByRole("radio", { name: "Date added" }).click();
  await expect(page.getByRole("heading", { name: /^Recently added/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: /^July 1998/ })).toHaveCount(0);

  // Date taken: it moves to where it belongs on the real timeline — last.
  await sort.getByRole("radio", { name: "Date taken" }).click();
  await expect(page.getByRole("heading", { name: /^July 1998/ })).toBeVisible();
  await expect(page.locator("figure").last()).toHaveAttribute(
    "aria-label",
    "View fireworks-1998.jpg",
  );
  await expect
    .poll(() => tile.locator("img").evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0);

  await tile.click();
  await expect(page.getByText("Taken July 4, 1998", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");

  // Put the default back for later specs.
  await sort.getByRole("radio", { name: "Date added" }).click();
});
