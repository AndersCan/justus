/**
 * Two real bare instances: Ben looks at an album and closes his page, Ada adds 2 photos, and
 * Ben opening the page the way the phone app does (`/index.html`) lands in that album with
 * "New" on Ada's 2 photos only.
 *
 * A second test, three phones: Ben scrolls Photos > All while Ada and Cy's photos are new, then
 * the album reads "3 new from Ada, 2 from Cy" and all 5 say New until he leaves and reopens it.
 *
 *   pnpm test:e2e-p2p -g "return"
 *   pnpm test:e2e-p2p -g "new from"
 */
// @ts-nocheck: the hub fixtures are untyped .mjs
import { expect, test } from "../hub/fixtures.mjs";
import { pngOf, runColour } from "../add-photos.js";
import { askToJoin, copyInviteLink, createAlbum, setName, skipIntro, words } from "./steps";

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

async function letIn(a, joiner, album, button) {
  const link = await copyInviteLink(a);
  await askToJoin(joiner, link, album);
  // 60 s: the join request travels over the hub to Ada's phone.
  await expect(a.getByText(`wants to join “${album}”`)).toBeVisible({ timeout: 60_000 });
  await a.getByRole("button", { name: button, exact: true }).click();
  await a.getByRole("link", { name: "See photos in this album" }).click();
  // 60 s: the album syncs to the joiner after Ada accepts.
  await expect(joiner).toHaveURL(/\/albums\/[^/]+$/, { timeout: 60_000 });
}

test("new from: Ben scrolls Photos > All, then the album reads 3 new from Ada, 2 from Cy and all 5 say New", async ({
  instancePages,
}) => {
  test.setTimeout(240_000);
  const [a, b, c] = instancePages;
  const run = Date.now().toString(36);
  const album = `New from ${run}`;
  const adaFiles = [1, 2, 3].map((i) => `${run}-ada-${i}.png`);
  const cyFiles = [1, 2].map((i) => `${run}-cy-${i}.png`);
  await skipIntro([a, b, c]);
  await setName(a, "Ada");
  await setName(b, "Ben");
  await setName(c, "Cy");
  await createAlbum(a, album, `${run}-first.png`, 71);
  await letIn(a, b, album, "Accept, can only look");
  await letIn(a, c, album, "Accept, can add photos");
  await expect(b.locator("img").first()).toBeAttached({ timeout: 60_000 });
  await b.close();

  const files = (names, from) =>
    names.map((name, i) => ({
      name,
      mimeType: "image/png",
      buffer: pngOf(...runColour(from + i)),
    }));
  await a.setInputFiles("input[type=file]", files(adaFiles, 72));
  await c.setInputFiles("input[type=file]", files(cyFiles, 80));

  const ben = await instancePages[1].context().newPage();
  await ben.goto("/");
  const runTiles = ben
    .locator("[data-photo-tile]")
    .filter({ has: ben.locator(`img[alt^="${run}-"]`) });
  const adaCyTiles = runTiles.filter({ has: ben.locator(`img[alt*="-ada-"], img[alt*="-cy-"]`) });
  // 90 s: Ada's and Cy's photos and the first one cross the hub to Ben's phone.
  await expect(runTiles).toHaveCount(6, { timeout: 90_000 });
  const marks = adaCyTiles.locator('[data-copy-id="gallery.new_photo"]');
  await expect(marks).toHaveCount(5);
  // Cause: the look rule counts a tile after 1 s on screen and sends it 1 s later; staying on All
  // past that is the behaviour under test (scrolling All must not clear New), not a wait for the app.
  await ben.waitForTimeout(2_500);

  await ben
    .getByRole("link", { name: words("gallery.albums"), exact: true })
    .first()
    .click();
  const card = ben.locator("[data-album-card]", { hasText: album });
  const cardCount = card.locator('[data-copy-id="gallery.new_count"]');
  await expect(cardCount).toHaveText(words("gallery.new_count", { count: 5 }));

  await card.click();
  await expect(ben.locator("[data-new-photos-line]")).toHaveText(
    words("gallery.new_from_first", { count: 3, name: "Ada" }) +
      words("gallery.new_from_next", { count: 2, name: "Cy" }),
  );
  await expect(marks).toHaveCount(5);

  await ben.locator('[data-copy-id="gallery.all_albums"]').click();
  await expect(cardCount).toHaveCount(0);
  await card.click();
  await expect(runTiles).toHaveCount(6);
  await expect(ben.locator("[data-new-photos-line]")).toHaveCount(0);
  await expect(marks).toHaveCount(0);
});
