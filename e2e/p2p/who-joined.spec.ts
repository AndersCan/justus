/**
 * Three real bare instances: Ben's phone is off while Ada lets Cy into the album, and when it
 * is back Ben's album page says Cy joined, in place of his own "You're now in" line, until he
 * taps Dismiss. Kept in its own file, after viewer-holders: join-flow's first-run test needs the
 * third phone untouched.
 *
 *   pnpm test:e2e-p2p -g "Ben reads that Cy joined"
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

test("Ben reads that Cy joined Summer in place of his own line, after his phone was off", async ({
  instancePages,
  instances,
}) => {
  test.setTimeout(240_000);
  const [a, b, c] = instancePages;
  await skipIntro([a, b, c]);
  await setName(a, "Ada");
  await setName(b, "Ben");
  await setName(c, "Cy");
  await createAlbum(a, ALBUM, FILE, 83);
  await letIn(a, b, "Accept, can add photos");
  const nowIn = b.getByText(words("notices.now_in_album", { albumName: ALBUM }));
  await expect(nowIn).toBeVisible({ timeout: 60_000 });
  try {
    const resumeBen = await pausePhone(instances[1]);
    await letIn(a, c, "Accept, can add photos");
    resumeBen();
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
