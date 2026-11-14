/**
 * copyInviteLink must return the link of the album it copied, not a link an
 * earlier test left on the clipboard. Main run 43578226803: delete-photo pasted
 * album-lifecycle's "Hytta" link (n=Hytta), so A never saw the ask and B kept a
 * "Link no longer works: Hytta" row that failed join-flow's Not now test.
 *
 *   pnpm test:e2e-p2p stale-clipboard
 */
// @ts-nocheck: the hub fixtures are untyped .mjs
import { expect, test } from "../hub/fixtures.mjs";
import { copyInviteLink, createAlbum, skipIntro } from "./steps";

test("copyInviteLink waits for this album's link, not the one already on the clipboard", async ({
  instancePages,
}) => {
  test.setTimeout(90_000);
  const [a] = instancePages;
  await skipIntro([a]);
  await createAlbum(a, "Clip old", "clip-old.png", 61);
  const old = await copyInviteLink(a);
  expect(new URL(old).searchParams.get("n")).toBe("Clip old");

  await createAlbum(a, "Clip new", "clip-new.png", 62);
  // A busy CI runner: the app writes the link a moment after the tap.
  await a.evaluate(() => {
    const write = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = (t) =>
      new Promise((r) => setTimeout(r, 1_000)).then(() => write(t));
  });
  const link = await copyInviteLink(a);
  expect(new URL(link).searchParams.get("n")).toBe("Clip new");
});
