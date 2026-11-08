/**
 * Two real bare instances, driven through the real UI: only the adder or the
 * album's Admin can delete a photo, and a delete reaches the other phone (its
 * open view closes by itself).
 *
 *   pnpm test:e2e-p2p -g "deletes only their own photo"
 */
// @ts-nocheck: the hub fixtures are untyped .mjs
import { expect, test } from "../hub/fixtures.mjs";
import { pngOf, runColour } from "../add-photos.js";

const ALBUM = "Delete trip";
const ANA = "del-ana.png";
const BEN = "del-ben.png";
const BEN2 = "del-ben2.png";

// The local DHT needs 5 nodes (apps/backend/scripts/local-dht.mjs): on 3, an idle
// album creator cannot NAT-sample enough nodes, aborts the joiner's holepunch,
// and the joiner times out. On failure the fixture attaches each instance's
// /__state and /__logs.
async function skipIntro(pages) {
  for (const page of pages) {
    await page.addInitScript(() => localStorage.setItem("justus:welcome-seen", "1"));
  }
}

async function createAlbum(a, name, file, colour) {
  await a.goto("/sharing");
  await a.getByLabel("Album name").fill(name);
  await a.getByRole("button", { name: "Create album" }).click();
  await expect(a).toHaveURL(/\/albums\/[^/]+$/, { timeout: 20_000 });
  await a.setInputFiles("input[type=file]", {
    name: file,
    mimeType: "image/png",
    buffer: pngOf(...runColour(colour)),
  });
  await expect(a.getByRole("button", { name: `View ${file}` }).locator("img")).toBeAttached({
    timeout: 20_000,
  });
}

async function copyInviteLink(a) {
  await a.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await a
    .getByRole("link", { name: /Invite & members/ })
    .first()
    .click();
  await a.getByRole("button", { name: /^(Copy invite link|Copy link)$/ }).click();
  const link = await a.evaluate(() => navigator.clipboard.readText());
  expect(link).toMatch(/^justus:\/\/join\?/);
  expect(link).toMatch(/[?&]e=\d+/);
  return link;
}

async function askToJoin(b, link, album) {
  await b.goto("/join");
  await b.getByLabel("Invite link").fill(link);
  await b.getByRole("button", { name: "Continue", exact: true }).click();
  const ask = b.getByRole("dialog", { name: `Ask to join “${album}”?` });
  await expect(ask).toBeVisible();
  await expect(b.locator("img")).toHaveCount(0);
  await ask.getByRole("button", { name: "Ask to join" }).click();
  await expect(b.getByRole("dialog", { name: /^Waiting for / })).toBeVisible({ timeout: 20_000 });
  await expect(b.locator("img")).toHaveCount(0);
}

test("a member deletes only their own photo, the Admin's delete closes Ben's open view, and both deletes leave both phones", async ({
  instancePages,
}) => {
  test.setTimeout(200_000);
  const [a, b] = instancePages;
  await skipIntro([a, b]);
  await createAlbum(a, ALBUM, ANA, 41);
  const link = await copyInviteLink(a);
  await askToJoin(b, link, ALBUM);
  await expect(a.getByText(`wants to join “${ALBUM}”`)).toBeVisible({ timeout: 60_000 });
  await a.getByRole("button", { name: "Accept as Collaborator", exact: true }).click();
  // Accepting happens on the members page; the photos are one tap away.
  await a.getByRole("link", { name: "See photos in this album" }).click();
  await expect(b).toHaveURL(/\/albums\/[^/]+$/, { timeout: 60_000 });
  await expect(b.getByRole("button", { name: `View ${ANA}` })).toBeVisible({ timeout: 60_000 });
  // Ben is a Viewer until the Admin's enrolment reaches his phone; adds before that are refused.
  await expect(b.getByRole("button", { name: `Add photos to ${ALBUM}` })).toBeVisible({
    timeout: 60_000,
  });

  for (const [file, colour] of [
    [BEN, 43],
    [BEN2, 47],
  ]) {
    await b.setInputFiles("input[type=file]", {
      name: file,
      mimeType: "image/png",
      buffer: pngOf(...runColour(colour)),
    });
    await expect(a.getByRole("button", { name: `View ${file}` })).toBeVisible({ timeout: 60_000 });
  }

  // Ben (a member) has no menu on Ana's photo.
  await b.getByRole("button", { name: `View ${ANA}` }).click();
  await expect(b.getByRole("button", { name: "Close" })).toBeVisible();
  await expect(b.getByRole("button", { name: "More options" })).toHaveCount(0);

  // The Admin deletes Ana's photo: Ben's open view closes by itself.
  await a.getByRole("button", { name: `View ${ANA}` }).click();
  await a.getByRole("button", { name: "More options" }).click();
  await a.getByRole("menuitem", { name: "Delete" }).click();
  const dialog = a.locator("wa-dialog[open]", { hasText: `Delete “${ANA}”?` });
  await expect(a.getByText(`Delete “${ANA}”?`)).toBeVisible();
  await expect(a.getByText("It will be gone from the album for everyone.")).toBeVisible();
  await dialog.locator("wa-button", { hasText: "Delete" }).click();
  await expect(a.getByRole("button", { name: "Close" })).toHaveCount(0);
  await expect(a.getByRole("button", { name: `View ${ANA}` })).toHaveCount(0);
  await expect(a.getByText(/Removed|Deleted/)).toHaveCount(0);
  await expect(b.getByRole("button", { name: "Close" })).toHaveCount(0, { timeout: 60_000 });
  await expect(b.getByRole("button", { name: `View ${ANA}` })).toHaveCount(0);

  // Ben deletes his own photo through the menu; it leaves both phones.
  await b.getByRole("button", { name: `View ${BEN}` }).click();
  await b.getByRole("button", { name: "More options" }).click();
  await b.getByRole("menuitem", { name: "Delete" }).click();
  await b
    .locator("wa-dialog[open]", { hasText: `Delete “${BEN}”?` })
    .locator("wa-button", { hasText: "Delete" })
    .click();
  await expect(b.getByRole("button", { name: `View ${BEN}` })).toHaveCount(0);
  await expect(a.getByRole("button", { name: `View ${BEN}` })).toHaveCount(0, {
    timeout: 60_000,
  });

  // The Admin deletes another member's photo; it leaves both phones.
  await a.getByRole("button", { name: `View ${BEN2}` }).click();
  await a.getByRole("button", { name: "More options" }).click();
  await a.getByRole("menuitem", { name: "Delete" }).click();
  await a
    .locator("wa-dialog[open]", { hasText: `Delete “${BEN2}”?` })
    .locator("wa-button", { hasText: "Delete" })
    .click();
  await expect(a.getByRole("button", { name: `View ${BEN2}` })).toHaveCount(0);
  await expect(b.getByRole("button", { name: `View ${BEN2}` })).toHaveCount(0, {
    timeout: 60_000,
  });
});
