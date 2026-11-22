/**
 * Two real bare instances: Ada adds 4 photos taken months ago, and Ben, on Photos > All, taps
 * "4 taken in <month>" and lands on that month's heading in Date taken, without saving it.
 *
 *   pnpm test:e2e-p2p -g "taken month"
 */
// @ts-nocheck: the hub fixtures are untyped .mjs
import { expect, test } from "../hub/fixtures.mjs";
import { askToJoin, copyInviteLink, createAlbum, skipIntro } from "./steps";

const BASE_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABQj/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCFALDHv//Z",
  "base64",
);

/** A JPEG whose EXIF DateTimeOriginal ("YYYY:MM:DD HH:MM:SS") is spliced in right after SOI. */
function jpegTakenAt(exifDate) {
  const date = Buffer.from(exifDate + "\0", "latin1");
  const tiff = Buffer.alloc(8 + 18 + 18 + date.length);
  tiff.write("II", 0, "latin1");
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8);
  tiff.writeUInt16LE(0x8769, 10);
  tiff.writeUInt16LE(4, 12);
  tiff.writeUInt32LE(1, 14);
  tiff.writeUInt32LE(26, 18);
  tiff.writeUInt16LE(1, 26);
  tiff.writeUInt16LE(0x9003, 28);
  tiff.writeUInt16LE(2, 30);
  tiff.writeUInt32LE(date.length, 32);
  tiff.writeUInt32LE(44, 36);
  date.copy(tiff, 44);
  const body = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const app1 = Buffer.from([0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 0xff]);
  return Buffer.concat([BASE_JPEG.subarray(0, 2), app1, body, BASE_JPEG.subarray(2)]);
}

test("taken month: Ben taps 4 taken in a past month on Photos and lands on it by date taken", async ({
  instancePages,
}) => {
  test.setTimeout(240_000);
  const [a, b] = instancePages;
  const id = Date.now().toString(36);
  const album = "Taken month " + id;
  await skipIntro([a, b]);
  await createAlbum(a, album, "taken-month-first.png", 71);
  const link = await copyInviteLink(a);
  await askToJoin(b, link, album);
  await expect(a.getByText(`wants to join \u201c${album}\u201d`)).toBeVisible({ timeout: 60_000 });
  await a.getByRole("button", { name: "Accept, can only look", exact: true }).click();
  await a.getByRole("link", { name: "See photos in this album" }).click();
  await expect(b).toHaveURL(/\/albums\/[^/]+$/, { timeout: 60_000 });

  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 4);
  const month = d.toLocaleString("en-US", { month: "long", year: "numeric" });
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const run = String(Date.now() % 60).padStart(2, "0");
  const names = [1, 2, 3, 4].map((i) => `taken-month-${id}-${i}.jpg`);
  await a.setInputFiles(
    "input[type=file]",
    names.map((name, i) => ({
      name,
      mimeType: "image/jpeg",
      buffer: jpegTakenAt(`${yyyy}:${mm}:0${i + 1} 12:${run}:00`),
    })),
  );
  for (const name of names) {
    await expect(a.getByRole("button", { name: `View ${name}` })).toBeVisible({ timeout: 60_000 });
  }

  await b
    .getByRole("navigation", { name: "Show photos" })
    .getByRole("link", { name: "All", exact: true })
    .click();
  const line = b
    .locator('button:has([data-copy-id="gallery.taken_in_month"])')
    .filter({ hasText: month });
  await expect(line).toBeVisible({ timeout: 60_000 });
  await line.click();

  await expect(b.getByRole("radio", { name: "Date taken" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  const heading = b.locator(`h2[data-photo-group="${month}"]`);
  await expect(heading).toBeFocused();
  await expect(heading).toBeInViewport();
  for (const name of names) {
    await expect(b.getByRole("button", { name: `View ${name}` })).toBeVisible();
  }
  expect(await b.evaluate(() => localStorage.getItem("justus:photo-sort"))).not.toBe("taken");

  /** LIMITATION(#1002): photos.list fails past 64 KB and later specs share Ada's phone, so the album goes. */
  await a.goto("/sharing");
  await a.getByRole("link", { name: `Invite & members of ${album}` }).click();
  await a.getByRole("button", { name: "More options" }).click();
  await a.getByRole("menuitem", { name: "Delete album" }).click();
  await a.getByRole("button", { name: "Delete album", exact: true }).click();
  await expect(a).toHaveURL(/\/sharing$/);
  await expect(b.getByRole("button", { name: new RegExp(`^View taken-month-${id}-`) })).toHaveCount(
    0,
    { timeout: 30_000 },
  );
  await b.goto("/sharing");
  const dismiss = b.getByRole("button", { name: `Dismiss notice about ${album}` });
  await expect(dismiss).toBeVisible({ timeout: 30_000 });
  await dismiss.click();
  await expect(dismiss).toHaveCount(0);
});
