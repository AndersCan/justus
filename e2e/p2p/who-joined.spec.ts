/**
 * Three real bare instances: Ben's phone is off while Ada lets Cy into the album, and when it
 * is back Ben's album page says Cy joined, in place of his own "You're now in" line, until he
 * taps Dismiss, and has Cy's photos. Kept in its own file, after viewer-holders: join-flow's first-run test needs the
 * third phone untouched.
 *
 *   pnpm test:e2e-p2p -g "Ben gets Cy's photos"
 */
// @ts-nocheck: the hub fixtures are untyped .mjs
import { expect, test } from "../hub/fixtures.mjs";
import { pngOf, runColour } from "../add-photos.js";
import {
  askToJoin,
  copyInviteLink,
  closePhoto,
  createAlbum,
  pausePhone,
  resumeAll,
  setName,
  skipIntro,
  words,
} from "./steps";

const ALBUM = "Summer joined";
const FILE = "joined-ada.png";

async function letIn(a, joiner, button) {
  const link = await copyInviteLink(a);
  await askToJoin(joiner, link, ALBUM);
  // 60 s: the join request travels over the hub to Ada's phone.
  await expect(a.getByText(`wants to join “${ALBUM}”`)).toBeVisible({ timeout: 60_000 });
  await a.getByRole("button", { name: button, exact: true }).click();
  await a.getByRole("link", { name: "See photos in this album" }).click();
  // 60 s: the album syncs to the joiner after Ada accepts.
  await expect(joiner).toHaveURL(/\/albums\/[^/]+$/, { timeout: 60_000 });
}

test("Ben gets Cy's photos and reads that Cy joined Summer in place of his own line, after his phone was off", async ({
  instancePages,
  instances,
}) => {
  test.setTimeout(330_000);
  const [a, b, c] = instancePages;
  await skipIntro([a, b, c]);
  await setName(a, "Ada");
  await setName(b, "Ben");
  await setName(c, "Cy");
  await createAlbum(a, ALBUM, FILE, 83);
  await letIn(a, b, "Accept, can add photos");
  const nowIn = b.getByText(words("notices.now_in_album", { albumName: ALBUM }));
  await expect(nowIn).toBeVisible({ timeout: 60_000 });
  const benConnected = a.getByText(words("gallery.connected_now", { connected: 1 }));
  // 60 s: Ada's phone shows Ben connected before he goes off; without this the off-wait below can pass at once.
  await expect(benConnected, "Ben on · Ada's phone: connected").toBeVisible({ timeout: 60_000 });
  // Ada's phone must know what Ben holds before he goes; until his report arrives it lists him as unsure and shows no "wait" line.
  await a.getByRole("button", { name: words("gallery.view", { name: FILE }) }).click();
  // 60 s: Ben's report reaches Ada's phone; the line names him as holder or as showing a preview, either way he is no longer unsure.
  await expect(
    a.locator(".justus-holders-text"),
    "Ada's phone: names Ben on the first photo",
  ).toHaveText(/Ben's/, { timeout: 60_000 });
  await closePhoto(a);
  try {
    const resumeBen = await pausePhone(instances[1]);
    // 90 s: Ada's phone drops a gone peer when its connection times out; until then Ben's phone is only slow, not off.
    await expect(benConnected, "Ben off · Ada's phone: still connected").toHaveCount(0, {
      timeout: 90_000,
    });
    await letIn(a, c, "Accept, can add photos");
    const files = [0, 1].map((i) => `cy-beach-${i + 1}.png`);
    await c.setInputFiles(
      "input[type=file]",
      files.map((name, i) => ({
        name,
        mimeType: "image/png",
        buffer: pngOf(...runColour(84 + i)),
      })),
    );
    for (const name of files) {
      const tile = (page) =>
        page.getByRole("button", { name: words("gallery.view", { name }) }).locator("img");
      // 20 s: two adds and their listing on Cy's phone.
      await expect(tile(c)).toBeAttached({ timeout: 20_000 });
      // 60 s: the photos travel from Cy's phone to Ada's.
      await expect(tile(a)).toBeAttached({ timeout: 60_000 });
    }
    const waits = a.locator('[data-copy-id^="gallery.photos_wait"]');
    // 60 s: Ada's phone lists Cy's photos as waiting; without this the later count of 0 proves nothing.
    await expect(
      a.locator('[data-copy-id="gallery.photos_wait_for_one"]'),
      "Ada's line while Ben is paused",
    ).toHaveText(words("gallery.photos_wait_for_one", { count: 2, name: "Ben" }), {
      timeout: 60_000,
    });
    resumeBen();
    for (const name of files) {
      // 90 s: Ben's phone hears of Cy from Ada's lists, then opens Cy's photos.
      await expect(
        b.getByRole("button", { name: words("gallery.view", { name }) }).locator("img"),
      ).toBeAttached({
        timeout: 90_000,
      });
    }
    // 60 s: Ada's line goes once Ben holds the photos.
    await expect(waits).toHaveCount(0, { timeout: 60_000 });
    const line = b
      .getByRole("status")
      .filter({ hasText: words("notices.joined_this_album", { name: "Cy" }) });
    // 90 s: Ben's phone catches up with Ada's record once it is back.
    await expect(line).toBeVisible({ timeout: 90_000 });
    await expect(nowIn).toHaveCount(0);
    await b
      .getByRole("button", { name: words("albums.dismiss_notice_about", { name: ALBUM }) })
      .click();
    await expect(line).toHaveCount(0);
  } finally {
    resumeAll();
  }
});
