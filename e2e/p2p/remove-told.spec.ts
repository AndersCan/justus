/**
 * Two real bare instances: Ben joins, his phone is taken off, Ada waits for his row to say Phone off, removes him,
 * and reads that his phone learns it the next time it connects. Ben's phone comes back and shows he is out.
 *
 *   pnpm test:e2e-p2p e2e/p2p/remove-told.spec.ts
 */
// @ts-nocheck: the hub fixtures are untyped .mjs
import { expect, test } from "../hub/fixtures.mjs";
import {
  askToJoin,
  copyInviteLink,
  createAlbum,
  pausePhone,
  resumeAll,
  setName,
  skipIntro,
  words,
} from "./steps";

const ALBUM = "Told Lake";

test.afterEach(() => resumeAll());

/** The Members row line for a friend whose phone is off. */
function phoneOff(when) {
  return words("people.phone_off_last_seen", { when: words("people.last_seen", { when }) });
}

test("Ada removes Ben while his phone is off, reads that it learns later, and Ben's phone then shows he is out", async ({
  instancePages,
  instances,
}) => {
  test.setTimeout(600_000);
  const [a, b] = instancePages;
  await skipIntro([a, b]);
  await setName(a, "Ada");
  await setName(b, "Ben");
  await createAlbum(a, ALBUM, "told-lake.png", 92);
  const link = await copyInviteLink(a);
  await askToJoin(b, link, ALBUM);
  // 60 s: the join request travels over the hub to Ada's phone.
  await expect(a.getByText(`wants to join “${ALBUM}”`), "join · Ada: request").toBeVisible({
    timeout: 60_000,
  });
  await a.getByRole("button", { name: "Accept, can add photos", exact: true }).click();
  // 60 s: the album syncs to Ben's phone after Ada accepts.
  await expect(b, "join · Ben: album opens").toHaveURL(/\/albums\/[^/]+$/, { timeout: 60_000 });

  const members = a.locator("section", { has: a.getByRole("heading", { name: "Members" }) });
  const benRow = members.locator("[data-member-key]", { hasText: "Ben" });
  // 60 s: Ben's row has a presence line only while his phone is not connected.
  await expect(
    b.getByRole("button", { name: "View told-lake.png" }),
    "join · Ben: photo",
  ).toBeVisible({
    timeout: 60_000,
  });
  await expect(
    benRow.locator("[data-member-presence]"),
    "join · Ada's Members: Ben's row is connected",
  ).toHaveCount(0, { timeout: 60_000 });
  const resumeBen = await pausePhone(instances[1]);
  try {
    // 180 s: a frozen phone's connection times out in about 33 s, then the off rule waits 30 s and the clock moves every 15 s.
    await expect(
      benRow.locator("[data-member-presence]"),
      "Ben off · Ada's Members: Ben's row",
    ).toHaveText(phoneOff(words("time.just_now")), { timeout: 180_000 });
    await benRow.getByRole("button", { name: words("album.remove_name", { name: "Ben" }) }).click();
    await a.locator("wa-dialog[open]").getByRole("button", { name: "Remove", exact: true }).click();
    // 60 s: the removal is recorded on Ada's phone; the toast lasts about 6 s.
    await expect(a.locator(".justus-toast"), "Ben off, removed · Ada's toast").toContainText(
      words("album.no_longer_in_phone_off", { name: "Ben", album: ALBUM }),
      {
        timeout: 60_000,
      },
    );
  } finally {
    resumeBen();
  }
  // 120 s: Ben's phone finds Ada's again and hears the removal.
  await expect(
    b.getByText(words("gallery.you_re_no_longer_in", { name: ALBUM })),
    "Ben back · Ben's phone: he is out",
  ).toBeVisible({ timeout: 120_000 });
});
