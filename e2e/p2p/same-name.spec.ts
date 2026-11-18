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
  copyInviteLink,
  createAlbum,
  pausePhone,
  resumeAll,
  skipIntro,
  words,
} from "./steps";

const FILE = "same-name-ada.png";

test.afterEach(() => resumeAll());

async function setName(page, name) {
  await page.goto("/settings");
  const field = page.getByRole("textbox", { name: words("settings.your_name"), exact: true });
  await field.fill(name);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(field).toHaveValue(name);
}

async function nameOf(page) {
  await page.goto("/settings");
  return page.getByRole("textbox", { name: words("settings.your_name"), exact: true }).inputValue();
}

function escaped(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The words for a Ben who is not connected: "last seen …", or "hasn't connected yet" when Ada's phone never saw his connection close. */
const NOT_CONNECTED = `(?:${escaped(words("people.last_seen", { when: "§" }).split("§")[0])}.+|${escaped(words("people.not_connected_yet"))})`;

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
    await expect(b.getByRole("button", { name: `View ${FILE}` })).toBeVisible({ timeout: 60_000 });

    // The old phone is gone.
    await pausePhone(instances[1]);
    // 90 s: Ada's phone drops a gone peer when its connection times out, about 33 s.
    await expect(
      a.getByText(words("gallery.connected_now", { connected: 1 })),
      "old Ben off · Ada's phone: not connected to him",
    ).toHaveCount(0, { timeout: 90_000 });

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
    await c.getByRole("button", { name: `View ${FILE}` }).click({ timeout: 60_000 });
    await expect(
      c.locator(".justus-holders-text"),
      "new Ben's phone: holders line has the photo",
    ).toContainText("Ada's", { timeout: 60_000 });

    await a.getByRole("link", { name: "See photos in this album" }).click();
    await expect(a, "Ada opens the album").toHaveURL(/\/albums\/[^/]+$/, { timeout: 20_000 });
    // 60 s: the album reloads from the phone's storage.
    await a.getByRole("button", { name: `View ${FILE}` }).click({ timeout: 60_000 });
    await expect(
      a.locator(".justus-holders-text"),
      "Ada's phone: holders line counts the two Bens",
    ).toHaveText(words("holders.on_your_phone_and", { k: 2 }), { timeout: 60_000 });
  } finally {
    await setName(c, cName);
  }
});
