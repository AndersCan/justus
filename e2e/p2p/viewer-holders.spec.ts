/**
 * Three real bare instances: Ben and Cy join Ada's album as Viewers, and each Viewer's "Who has this
 * photo" sheet names what the other Viewer's phone has. Kept in its own file, last in the suite:
 * it gives the third phone a name and an album, and join-flow's first-run test needs that phone untouched.
 *
 *   pnpm test:e2e-p2p e2e/p2p/viewer-holders.spec.ts
 */
// @ts-nocheck: the hub fixtures are untyped .mjs
import { expect, test } from "../hub/fixtures.mjs";
import {
  askToJoin,
  closePhoto,
  copyInviteLink,
  createAlbum,
  setName,
  skipIntro,
  words,
} from "./steps";

const FILE = "holders-ada.png";

const VIEWERS_ALBUM = "Holders viewers";

/** Opens the photo if none is open, then its "Who has this photo" sheet. */
async function openSheet(page) {
  if ((await page.locator(".justus-holders-text").count()) === 0) {
    await page.getByRole("button", { name: `View ${FILE}` }).click();
  }
  await page.locator("[data-holders-row]").click();
  return page.getByRole("dialog", { name: words("photo_holders.who_has_this_photo") });
}

/** The names listed under the sheet heading with copy id `id`. */
const namesUnder = (sheet, id) => sheet.locator(`h4:has([data-copy-id="${id}"]) + ul li .text-fg`);

/** Expects the sheet to list `full` under "Has the full photo", `preview` under "Has the preview", and nobody under "Hasn't said yet". */
async function expectSheet(page, step, phone, { full, preview }) {
  const sheet = await openSheet(page);
  // 60 s: the other phone's record replicates over the hub.
  await expect(
    namesUnder(sheet, "full_photo.has"),
    `${step} · ${phone}'s sheet: full photo`,
  ).toHaveText(full, { timeout: 60_000 });
  await expect(
    namesUnder(sheet, "full_photo.only_preview"),
    `${step} · ${phone}'s sheet: preview`,
  ).toHaveText(preview, { timeout: 60_000 });
  await expect(
    sheet.locator('[data-copy-id="photo_holders.hasn_t_said_yet"]'),
    `${step} · ${phone}'s sheet: hasn't said yet`,
  ).toHaveCount(0);
  await sheet.locator('[data-copy-id="photo_holders.close"]').click();
  await expect(sheet).toHaveCount(0);
  await closePhoto(page);
}

test("a Viewer's sheet names what another Viewer's phone has, as the Admin's does, also after a reload", async ({
  instancePages,
}) => {
  test.setTimeout(180_000);
  const [a, b, c] = instancePages;
  await skipIntro([a, b, c]);
  await setName(a, "Ada");
  await setName(b, "Ben");
  await setName(c, "Cy");
  await createAlbum(a, VIEWERS_ALBUM, FILE, 71);
  for (const page of [b, c]) {
    const link = await copyInviteLink(a);
    await askToJoin(page, link, VIEWERS_ALBUM);
    // 60 s: the join request travels over the hub to Ada's phone.
    await expect(a.getByText(`wants to join “${VIEWERS_ALBUM}”`)).toBeVisible({ timeout: 60_000 });
    await a.getByRole("button", { name: "Accept, can only look", exact: true }).click();
    await a.getByRole("link", { name: "See photos in this album" }).click();
    // 60 s: the album and its photo sync to the joiner after Ada accepts.
    await expect(page).toHaveURL(/\/albums\/[^/]+$/, { timeout: 60_000 });
    await expect(page.getByRole("button", { name: `View ${FILE}` })).toBeVisible({
      timeout: 60_000,
    });
  }
  const you = words("photo_holders.you");
  await expectSheet(b, "Cy previewed", "Ben", { full: [you, "Ada"], preview: ["Cy"] });
  // join-flow's friend test saves this phone as "Sam" on Ada's phone, and a friend name wins on her sheet.
  await expectSheet(a, "Cy previewed", "Ada", { full: [you, /^(Ben|Sam)$/], preview: ["Cy"] });
  await b.reload();
  await expectSheet(b, "Ben reloaded", "Ben", { full: [you, "Ada"], preview: ["Cy"] });
});
