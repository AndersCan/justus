/**
 * Three real bare instances, one story: Ada and Ben are in an album, Ben's phone goes away, a
 * "reinstalled" Ben (a new phone with the same name) asks with the same link. Ada's request
 * card says a Ben is already in, and once she accepts, Members and the photo's holders line
 * tell the two Bens apart.
 *
 *   pnpm test:e2e-p2p e2e/p2p/same-name.spec.ts
 */
// @ts-nocheck: the hub fixtures are untyped .mjs
import { expect, test } from "../hub/fixtures.mjs";
import {
  askToJoin,
  closePhoto,
  copyInviteLink,
  createAlbum,
  pausePhone,
  resumeAll,
  setName,
  skipIntro,
  words,
} from "./steps";

const FILE = "same-name-ada.png";

test.afterEach(() => resumeAll());

async function nameOf(page) {
  await page.goto("/settings");
  const field = page.getByRole("textbox", { name: words("settings.your_name"), exact: true });
  // The field is empty until the phone's status arrives; every phone has a name.
  await expect(field, "c's name has loaded").not.toHaveValue("", { timeout: 20_000 });
  return field.inputValue();
}

/** Ada may keep a friend from an earlier test (the old Ben saved as "Sam"); a saved friend hides the same-name line. */
async function removeAllFriends(page) {
  await page.goto("/settings");
  const [before, after] = words("settings_friends.remove_label", { name: "§" }).split("§");
  const remove = page.getByRole("button", {
    name: new RegExp(`^${escaped(before)}.+${escaped(after)}$`),
  });
  for (let left = await remove.count(); left > 0; left--) {
    await remove.first().click();
    const confirm = page.getByRole("button", {
      name: words("settings_friends.remove"),
      exact: true,
    });
    await confirm.last().click();
    await expect(remove, "a friend is removed").toHaveCount(left - 1);
  }
  await expect(remove, "Ada has no saved friends").toHaveCount(0);
}

function escaped(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The words for a Ben who was connected and is gone: "Phone off, last seen …". */
const NOT_CONNECTED = `(?:${escaped(words("people.phone_off_last_seen", { when: words("people.last_seen", { when: "§" }) }).split("§")[0])}.+)`;

/** A regex for `id`'s text with the not-connected words in place of the presence placeholder. */
function withNotConnected(id, params) {
  const [before, after] = words(id, { ...params, presence: "§" }).split("§");
  return new RegExp(`^${escaped(before)}${NOT_CONNECTED}${escaped(after)}$`);
}

test("a reinstalled Ben's request says a Ben is already in, and Members and the holders line tell the two apart", async ({
  instancePages,
  instances,
}) => {
  test.setTimeout(240_000);
  const [a, b, c] = instancePages;
  const album = `Same name ${Date.now().toString(36)}`;
  await skipIntro([a, b, c]);
  const cName = await nameOf(c);
  try {
    await removeAllFriends(a);
    await setName(a, "Ada");
    await setName(b, "Ben");
    await setName(c, "Ben");
    await createAlbum(a, album, FILE, 62);
    const link = await copyInviteLink(a);

    await askToJoin(b, link, album);
    const accept = words("album.accept_as_collaborator");
    // 60 s: the join request travels over the hub to Ada's phone.
    await expect(a.getByRole("button", { name: accept, exact: true }), "Ben asks").toBeVisible({
      timeout: 60_000,
    });
    await a.getByRole("button", { name: accept, exact: true }).click();
    // 60 s: the album syncs to Ben's phone after Ada accepts.
    await expect(b, "Ben lands in the album").toHaveURL(/\/albums\/[^/]+$/, { timeout: 60_000 });
    // The old Ben opens the photo so his phone holds it, as the new Ben's will.
    await b
      .getByRole("button", { name: words("gallery.view", { name: FILE }) })
      .click({ timeout: 60_000 });
    await expect(
      b.locator(".justus-holders-text"),
      "old Ben's phone: holders line has the photo",
    ).toHaveText(words("holders.on_and_your_phone", { names: "Ada's" }), { timeout: 60_000 });
    await closePhoto(b);

    // Ada's phone knows the old Ben holds the photo before his phone goes.
    // 60 s: Ben's name reaches Ada's phone after he joins.
    await expect(
      a.locator("li[data-member-key]").filter({ hasText: "Ben" }),
      "Ada's Members: Ben is named",
    ).toHaveCount(1, { timeout: 60_000 });
    await a.getByRole("link", { name: words("album.see_photos_in_this_album") }).click();
    await a
      .getByRole("button", { name: words("gallery.view", { name: FILE }) })
      .click({ timeout: 60_000 });
    await expect(
      a.locator(".justus-holders-text"),
      "Ada's phone: old Ben holds the photo",
    ).toHaveText(words("holders.on_and_your_phone", { names: "Ben's" }), { timeout: 60_000 });
    await closePhoto(a);
    await a.goBack();

    // The old phone is gone.
    await pausePhone(instances[1]);
    // 120 s: a frozen phone's connection times out in about 33 s, then the off rule waits 30 s and the clock moves every 15 s.
    await expect(
      a.getByText(words("gallery.connected_now", { connected: 1 })),
      "old Ben off · Ada's phone: not connected to him",
    ).toHaveCount(0, { timeout: 120_000 });

    // The new Ben asks with the same link.
    await askToJoin(c, link, album);
    const card = a.locator('[data-copy-id="album.same_name_in"]');
    // 60 s: the join request travels over the hub to Ada's phone.
    await expect(card, "new Ben asks · Ada's card says a Ben is already in").toHaveText(
      withNotConnected("album.same_name_in", { name: "Ben", folderName: album }),
      { timeout: 60_000 },
    );
    await a.getByRole("button", { name: accept, exact: true }).click();

    // 60 s: the accept is answered over the hub before the request leaves the list.
    await expect(card, "accepted · the request card is gone").toHaveCount(0, { timeout: 60_000 });
    const bens = a.locator("li[data-member-key]").filter({ hasText: "Ben" });
    // 60 s: the new member row arrives after Ada accepts.
    await expect(bens, "accepted · Ada's Members: two Bens").toHaveCount(2, { timeout: 60_000 });
    const notConnected = new RegExp(`^${NOT_CONNECTED}$`);
    await expect(
      bens.locator("p").getByText(words("people.connected"), { exact: true }),
      "Ada's Members: one Ben connected",
    ).toHaveCount(1);
    await expect(
      bens.locator("p").getByText(notConnected),
      "Ada's Members: one Ben not connected",
    ).toHaveCount(1);

    // The new Ben opens the photo, then Ada reads two holders without names.
    // 60 s: the album and its photo sync to the new phone after Ada accepts.
    await expect(c, "new Ben lands in the album").toHaveURL(/\/albums\/[^/]+$/, {
      timeout: 60_000,
    });
    await c
      .getByRole("button", { name: words("gallery.view", { name: FILE }) })
      .click({ timeout: 60_000 });
    await expect(
      c.locator(".justus-holders-text"),
      "new Ben's phone: holders line has the photo",
    ).toContainText("Ada's", { timeout: 60_000 });

    await a.getByRole("link", { name: words("album.see_photos_in_this_album") }).click();
    await expect(a, "Ada opens the album").toHaveURL(/\/albums\/[^/]+$/, { timeout: 20_000 });
    // 60 s: the album reloads from the phone's storage.
    await a
      .getByRole("button", { name: words("gallery.view", { name: FILE }) })
      .click({ timeout: 60_000 });
    await expect(
      a.locator(".justus-holders-text"),
      "Ada's phone: holders line counts the two Bens",
    ).toHaveText(words("holders.on_your_phone_and", { k: 2 }), { timeout: 60_000 });
  } finally {
    await setName(c, cName);
  }
});
