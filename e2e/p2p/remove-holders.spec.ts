/**
 * Two real bare instances: Ben opens one of Ada's two photos and adds one. Ada's Remove sheet says what his
 * phone keeps (the photo he opened and his own, not the one he only has a preview of), she removes him,
 * and his photo leaves her album.
 *
 *   pnpm test:e2e-p2p e2e/p2p/remove-holders.spec.ts
 */
// @ts-nocheck: the hub fixtures are untyped .mjs
import { expect, test } from "../hub/fixtures.mjs";
import { pngOf, runColour } from "../add-photos.js";
import {
  askToJoin,
  closePhoto,
  copyInviteLink,
  createAlbum,
  setName,
  skipIntro,
  words,
} from "./steps";

const ALBUM = "Remove trip";
const ADA_1 = "remove-ada-1.png";
const ADA_2 = "remove-ada-2.png";
const BEN_FILE = "remove-ben.png";

test("Ada reads her Remove sheet, removes Ben, and his photo leaves her album", async ({
  instancePages,
}) => {
  test.setTimeout(360_000);
  const [a, b] = instancePages;
  await skipIntro([a, b]);
  await setName(a, "Ada");
  await setName(b, "Ben");
  await createAlbum(a, ALBUM, ADA_1, 81);
  await a.setInputFiles("input[type=file]", {
    name: ADA_2,
    mimeType: "image/png",
    buffer: pngOf(...runColour(82)),
  });
  await expect(a.getByRole("button", { name: `View ${ADA_2}` }).locator("img")).toBeAttached({
    timeout: 20_000,
  });

  const link = await copyInviteLink(a);
  await askToJoin(b, link, ALBUM);
  // 60 s: the join request travels over the hub to Ada's phone.
  await expect(a.getByText(`wants to join “${ALBUM}”`)).toBeVisible({ timeout: 60_000 });
  await a.getByRole("button", { name: "Accept, can add photos", exact: true }).click();
  await a.getByRole("link", { name: "See photos in this album" }).click();
  // 60 s: the album and its photos sync to Ben's phone after Ada accepts.
  await expect(b).toHaveURL(/\/albums\/[^/]+$/, { timeout: 60_000 });
  await Promise.all(
    [ADA_1, ADA_2].map((file) =>
      expect(b.getByRole("button", { name: `View ${file}` }), `join · Ben: ${file}`).toBeVisible({
        timeout: 60_000,
      }),
    ),
  );

  // Ben opens the first photo only, so he holds it in full and has a preview of the second.
  await b.getByRole("button", { name: `View ${ADA_1}` }).click();
  // 60 s: the full photo can take that long to arrive on a loaded runner.
  await expect(b.locator(".justus-holders-text"), "open · Ben: holders line").toHaveText(
    words("holders.on_and_your_phone", { names: "Ada's" }),
    { timeout: 60_000 },
  );
  await closePhoto(b);

  await b.setInputFiles("input[type=file]", {
    name: BEN_FILE,
    mimeType: "image/png",
    buffer: pngOf(...runColour(83)),
  });
  // 60 s: Ben's photo reaches Ada's phone.
  await expect(
    a.getByRole("button", { name: `View ${BEN_FILE}` }),
    "add · Ada: Ben's photo",
  ).toBeVisible({ timeout: 60_000 });

  await a
    .getByRole("link", { name: /Invite & members/ })
    .first()
    .click();
  const rows = a.locator("section", { has: a.getByRole("heading", { name: "Members" }) });
  const benRow = rows.locator("[data-member-key]", { hasText: "Ben" });
  // 60 s: Ada's phone reads Ben's record. At a miss the sheet poll below is the real check.
  await expect(
    benRow.locator("[data-member-photos]"),
    "Ben has 2 photos and 1 preview · Members: Ben's row",
  )
    .toHaveText(
      `${words("members.n_in_full", { n: 2 })}, ${words("members.n_previews", { n: 1 })}`,
      {
        timeout: 60_000,
      },
    )
    .catch(() => {});

  const one = words("album.1_photo");
  const expected =
    words("album.remove_keeps", {
      name: "Ben",
      parts: words("album.and", {
        others: words("album.remove_part_yours", { n: 1 }),
        last: words("album.remove_part_added", { count: one, name: "Ben" }),
      }),
    }) +
    words("album.remove_added_leave_now", { name: "Ben" }) +
    words("album.remove_sees_and_everyone_else", { name: "Ben" });

  const sheetText = a.locator("wa-dialog[open] p");
  const openSheet = async () => {
    await benRow.getByRole("button", { name: words("album.remove_name", { name: "Ben" }) }).click();
    return sheetText.innerText({ timeout: 10_000 });
  };
  // The sheet is a snapshot when it opens, so reopen it until Ben's report has reached Ada's phone.
  await expect
    .poll(
      async () => {
        const text = await openSheet();
        if (text !== expected) await a.getByRole("button", { name: "Keep", exact: true }).click();
        return text;
      },
      { message: "Ada's Remove sheet", timeout: 90_000, intervals: [1000] },
    )
    .toBe(expected);

  await a.locator("wa-dialog[open]").getByRole("button", { name: "Remove", exact: true }).click();
  // 60 s: the removal is recorded on Ada's phone.
  await expect(a.getByText(`is no longer in ${ALBUM}`), "remove · Ada").toBeVisible({
    timeout: 60_000,
  });
  await a.getByRole("link", { name: "See photos in this album" }).click();
  await expect(
    a.getByRole("button", { name: `View ${ADA_1}` }),
    "after remove · Ada: her photo",
  ).toBeVisible();
  // The sheet said Ben's photos leave her album now.
  await expect(
    a.getByRole("button", { name: `View ${BEN_FILE}` }),
    "after remove · Ada: Ben's photo",
  ).toHaveCount(0, { timeout: 20_000 });
});
