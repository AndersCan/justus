/**
 * Two real bare instances: Ben looks at an album and closes his page, Ada adds 2 photos, and
 * Ben opening the page the way the phone app does (`/index.html`) lands in that album with
 * "New" on Ada's 2 photos only.
 *
 *   pnpm test:e2e-p2p -g "return"
 */
// @ts-nocheck: the hub fixtures are untyped .mjs
import { expect, test } from "../hub/fixtures.mjs";
import { pngOf, runColour } from "../add-photos.js";
import { askToJoin, copyInviteLink, createAlbum, skipIntro } from "./steps";

const ALBUM = "Return trip";
const FIRST = "return-first.png";
const NEW_PHOTOS = ["return-new-1.png", "return-new-2.png"];

test("Ben's phone app opens on the album with Ada's 2 new photos marked New", async ({
  instancePages,
}) => {
  test.setTimeout(240_000);
  const [a, b] = instancePages;
  await skipIntro([a, b]);
  await createAlbum(a, ALBUM, FIRST, 61);
  const link = await copyInviteLink(a);
  await askToJoin(b, link, ALBUM);
  await expect(a.getByText(`wants to join “${ALBUM}”`)).toBeVisible({ timeout: 60_000 });
  await a.getByRole("button", { name: "Accept, can only look", exact: true }).click();
  await a.getByRole("link", { name: "See photos in this album" }).click();
  await expect(b).toHaveURL(/\/albums\/[^/]+$/, { timeout: 60_000 });
  await expect(b.getByRole("button", { name: `View ${FIRST}` }).locator("img")).toBeAttached({
    timeout: 60_000,
  });
  const albumPath = new URL(b.url()).pathname;

  // Ben looks at the album (a tile counts as seen after 1 s on screen), then his page goes away.
  await b.waitForTimeout(2500);
  await b.close();

  await a.setInputFiles(
    "input[type=file]",
    NEW_PHOTOS.map((name, i) => ({
      name,
      mimeType: "image/png",
      buffer: pngOf(...runColour(62 + i)),
    })),
  );
  for (const name of NEW_PHOTOS) {
    await expect(a.getByRole("button", { name: `View ${name}` })).toBeVisible({ timeout: 60_000 });
  }

  // The phone app starts the page at /index.html.
  const ben = await instancePages[1].context().newPage();
  await ben.goto("/index.html");
  await expect(ben).toHaveURL(new RegExp(`${albumPath}$`), { timeout: 60_000 });
  await expect(ben.locator('[data-copy-id="gallery.new_photo"]')).toHaveCount(2, {
    timeout: 60_000,
  });
  for (const name of NEW_PHOTOS) {
    await expect(
      ben
        .getByRole("button", { name: `View ${name}` })
        .locator('[data-copy-id="gallery.new_photo"]'),
    ).toHaveCount(1);
  }
  await expect(
    ben
      .getByRole("button", { name: `View ${FIRST}` })
      .locator('[data-copy-id="gallery.new_photo"]'),
  ).toHaveCount(0);
});
