/**
 * Two real bare instances: Ben joins Ada's album and adds a photo. His Leave sheet names Ada as losing it now,
 * he leaves, and Ada's album no longer lists his photo.
 *
 *   pnpm test:e2e-p2p e2e/p2p/leave-holders.spec.ts
 */
// @ts-nocheck: the hub fixtures are untyped .mjs
import { expect, test } from "../hub/fixtures.mjs";
import { pngOf, runColour } from "../add-photos.js";
import { spokenSheet } from "../spoken";
import { askToJoin, copyInviteLink, createAlbum, setName, skipIntro, words } from "./steps";

const ALBUM = "Leave trip";
const ADA_FILE = "leave-ada.png";
const BEN_FILE = "leave-ben.png";

test("Ben reads his Leave sheet, leaves, and Ada's album drops his photo", async ({
  instancePages,
}) => {
  test.setTimeout(300_000);
  const [a, b] = instancePages;
  await skipIntro([a, b]);
  await setName(a, "Ada");
  await setName(b, "Ben");
  await createAlbum(a, ALBUM, ADA_FILE, 71);

  const link = await copyInviteLink(a);
  await askToJoin(b, link, ALBUM);
  // 60 s: the join request travels over the hub to Ada's phone.
  await expect(a.getByText(`wants to join “${ALBUM}”`)).toBeVisible({ timeout: 60_000 });
  await a.getByRole("button", { name: "Accept, can add photos", exact: true }).click();
  await a.getByRole("link", { name: "See photos in this album" }).click();
  // 60 s: the album and its photo sync to Ben's phone after Ada accepts.
  await expect(b).toHaveURL(/\/albums\/[^/]+$/, { timeout: 60_000 });
  await expect(b.getByRole("button", { name: `View ${ADA_FILE}` })).toBeVisible({
    timeout: 60_000,
  });

  await b.setInputFiles("input[type=file]", {
    name: BEN_FILE,
    mimeType: "image/png",
    buffer: pngOf(...runColour(72)),
  });
  await expect(b.getByRole("button", { name: `View ${BEN_FILE}` }).locator("img")).toBeAttached({
    timeout: 20_000,
  });
  // 60 s: the photo reaches Ada's phone.
  await expect(a.getByRole("button", { name: `View ${BEN_FILE}` })).toBeVisible({
    timeout: 60_000,
  });

  const sheetText = b.locator("wa-dialog[open] p");
  const expected =
    words("album.leave_takes_your_photos", { count: words("album.1_photo") }) +
    words("album.leave_photos_removed_everywhere", { count: words("album.1_photo") }) +
    words("album.leave_lose_them_now", { list: "Ada", n: 1, k: 1 }) +
    words("album.leave_come_back", { adminName: "Ada" });

  const openSheet = async () => {
    await b.goto("/sharing");
    await b.getByRole("link", { name: `Invite & members of ${ALBUM}` }).click();
    const more = b.getByRole("button", { name: "More options" });
    await expect(more).toBeEnabled({ timeout: 30_000 });
    await more.click();
    await b.getByRole("menuitem", { name: "Leave album" }).click();
    return sheetText.innerText({ timeout: 10_000 });
  };
  // The sheet is a snapshot when it opens, so reopen it until Ada's copy and her presence are known.
  await expect
    .poll(
      async () => {
        const text = await openSheet();
        if (text !== expected) await b.getByRole("button", { name: "Keep", exact: true }).click();
        return text;
      },
      { message: "Ben's Leave sheet", timeout: 90_000, intervals: [1000] },
    )
    .toBe(expected);

  const sheet = await spokenSheet(b);
  expect(sheet.name, "Ben · Leave sheet is named as shown").toBe(
    words("album.leave", { name: ALBUM }),
  );
  expect(sheet.shown.text, "Ben · Leave sheet text").toBe(expected);
  expect(sheet.buttons, "Ben · Keep says the sheet's text").toEqual([
    { name: words("confirm.keep"), description: sheet.shown.text },
    { name: words("album.leave_2"), description: "" },
  ]);

  await b.getByRole("button", { name: "Leave", exact: true }).click();
  await expect(b).toHaveURL(/\/sharing$/, { timeout: 30_000 });
  await expect(
    b.getByRole("status").filter({ hasText: words("notices.you_left", { albumName: ALBUM }) }),
  ).toBeVisible();

  // 60 s: Ben's phone removes his photo entries and Ada's phone reads the note.
  await expect(a.getByRole("button", { name: `View ${BEN_FILE}` })).toHaveCount(0, {
    timeout: 60_000,
  });
  await expect(a.getByRole("button", { name: `View ${ADA_FILE}` })).toBeVisible();
});
