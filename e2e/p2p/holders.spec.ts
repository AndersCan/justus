/**
 * Two real bare instances, one story: Ada adds a photo, Ben joins and opens it, Ben's phone is
 * taken off and back, Ada removes Ben, Ada deletes the photo. After each step the "who has this
 * photo" line is read on the phones that have one; a wrong line fails with the step, the phone,
 * and both texts.
 *
 *   pnpm test:e2e-p2p e2e/p2p/holders.spec.ts
 */
// @ts-nocheck: the hub fixtures are untyped .mjs
import { expect, test } from "../hub/fixtures.mjs";
import {
  askToJoin,
  copyInviteLink,
  createAlbum,
  pausePhone,
  resumeAll,
  skipIntro,
  words,
} from "./steps";

const ALBUM = "Holders trip";
const FILE = "holders-ada.png";

test.afterEach(() => resumeAll());

async function setName(page, name) {
  await page.goto("/settings");
  const field = page.getByRole("textbox", { name: "Your name", exact: true });
  await field.fill(name);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(field).toHaveValue(name);
}

/** Opens the photo if none is open, then expects its holders line to read exactly `text`. */
async function expectHoldersLine(page, step, phone, text) {
  const line = page.locator(".justus-holders-text");
  if ((await line.count()) === 0) {
    await page.getByRole("button", { name: `View ${FILE}` }).click();
  }
  // 60 s: the full photo can take that long to arrive on a loaded runner; the wait ends when the text matches.
  await expect(line, `${step} · ${phone}'s phone: holders line`).toHaveText(text, {
    timeout: 60_000,
  });
}

async function closePhoto(page) {
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.locator(".justus-holders-text")).toHaveCount(0);
}

test("every holders line reads right on both phones from add to delete", async ({
  instancePages,
  instances,
}) => {
  test.setTimeout(240_000);
  const [a, b] = instancePages;
  await skipIntro([a, b]);
  await setName(a, "Ada");
  await setName(b, "Ben");
  await createAlbum(a, ALBUM, FILE, 61);

  await expectHoldersLine(a, "add", "Ada", words("holders.only_on_your_phone"));
  await closePhoto(a);

  const link = await copyInviteLink(a);
  await askToJoin(b, link, ALBUM);
  // 60 s: the join request travels over the hub to Ada's phone.
  await expect(a.getByText(`wants to join “${ALBUM}”`)).toBeVisible({ timeout: 60_000 });
  await a.getByRole("button", { name: "Accept, can add photos", exact: true }).click();
  await a.getByRole("link", { name: "See photos in this album" }).click();
  // 60 s: the album and its photo sync to Ben's phone after Ada accepts.
  await expect(b).toHaveURL(/\/albums\/[^/]+$/, { timeout: 60_000 });
  await expect(b.getByRole("button", { name: `View ${FILE}` })).toBeVisible({ timeout: 60_000 });

  await expectHoldersLine(a, "join", "Ada", words("holders.only_on_your_phone_so"));
  await expectHoldersLine(b, "open", "Ben", words("holders.on_and_your_phone", { names: "Ada's" }));
  await expectHoldersLine(a, "open", "Ada", words("holders.on_and_your_phone", { names: "Ben's" }));
  await closePhoto(a);
  await closePhoto(b);

  const resume = await pausePhone(instances[1]);
  try {
    // 90 s: Ada's phone drops a gone peer when its connection times out, about 33 s.
    await expect(
      a.getByText(words("gallery.connected_now", { connected: 1 })),
      "Ben off · Ada's phone: still connected",
    ).toHaveCount(0, { timeout: 90_000 });
    await expectHoldersLine(
      a,
      "Ben off",
      "Ada",
      words("holders.on_and_your_phone", { names: "Ben's" }),
    );
    await closePhoto(a);
  } finally {
    resume();
  }
  // 60 s: reconnecting after a resume took 2-16 s; the removal must reach Ben.
  for (const page of [a, b]) {
    await expect(
      page.getByText(words("gallery.connected_now", { connected: 1 })),
      "Ben back: both phones connected",
    ).toBeVisible({ timeout: 60_000 });
  }

  await a
    .getByRole("link", { name: /Invite & members/ })
    .first()
    .click();
  const people = a.locator("section", { has: a.getByRole("heading", { name: "Members" }) });
  await people.getByRole("button", { name: /^Remove /, exact: false }).click();
  await a.getByRole("button", { name: "Remove", exact: true }).last().click();
  // 60 s: the removal syncs to both phones over the hub.
  await expect(a.getByText(`is no longer in ${ALBUM}`)).toBeVisible({ timeout: 60_000 });
  await expect(b.getByText(words("gallery.you_re_no_longer_in", { name: ALBUM }))).toBeVisible({
    timeout: 60_000,
  });

  await a.getByRole("link", { name: "See photos in this album" }).click();
  await expectHoldersLine(a, "remove", "Ada", words("holders.on_your_phone_and", { k: 1 }));
  await expectHoldersLine(b, "remove", "Ben", words("holders.on_your_phone_removed"));
  await closePhoto(b);

  await a.getByRole("button", { name: "More options" }).click();
  await a.getByRole("menuitem", { name: "Delete" }).click();
  await a
    .locator("wa-dialog[open]", { hasText: `Delete “${FILE}”?` })
    .getByRole("button", { name: "Delete" })
    .click();
  // 20 s: a local delete.
  await expect(a.getByRole("button", { name: `View ${FILE}` })).toHaveCount(0, {
    timeout: 20_000,
  });
  await expectHoldersLine(b, "delete", "Ben", words("holders.on_your_phone_removed"));
});
