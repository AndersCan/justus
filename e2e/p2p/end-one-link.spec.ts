/**
 * Two real bare instances: Ada makes two links to one album and ends the second. Ben's ask through
 * the ended link is turned away and never reaches her; the first link still lets him in.
 *
 *   pnpm test:e2e-p2p e2e/p2p/end-one-link.spec.ts
 */
// @ts-nocheck: the hub fixtures are untyped .mjs
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "../hub/fixtures.mjs";
import {
  copyInviteLink,
  createAlbum,
  pattern,
  resumeAll,
  setName,
  skipIntro,
  words,
} from "./steps";

const ALBUM = "End one link";

/** The link times Ada's phone saved for the album, read from its state file. */
function savedLinks(storageDir) {
  const text = readFileSync(resolve(storageDir, "justus.json"), "utf8");
  const found = [];
  JSON.parse(text, (key, value) => {
    if (key === "links" && Array.isArray(value)) found.push(...value);
    return value;
  });
  return found;
}

/** A link's end in ms, from its `e=` (seconds). */
const endOf = (link) => Number(/[#&]e=(\d+)/.exec(link)[1]) * 1000;

test.afterEach(() => resumeAll());

test("an ask through an ended link is turned away while Ada's other link lets Ben in", async ({
  instancePages,
  instances,
}) => {
  test.setTimeout(240_000);
  const [a, b] = instancePages;
  await skipIntro([a, b]);
  await setName(a, "Ada");
  await setName(b, "Ben");
  await createAlbum(a, ALBUM, "end-one-link.png", 71);

  const linkA = await copyInviteLink(a);
  await a.getByRole("combobox", { name: "Link works for" }).selectOption("7d");
  await a.evaluate(() => navigator.clipboard.writeText(""));
  await a.getByRole("button", { name: words("invite.make_a_new_link"), exact: true }).click();
  await expect.poll(() => a.evaluate(() => navigator.clipboard.readText())).toMatch(/#i=/);
  const linkB = await a.evaluate(() => navigator.clipboard.readText());
  expect(linkB).not.toBe(linkA);

  const rows = a.locator("[data-link-row]");
  await expect(rows).toHaveCount(2, { timeout: 20_000 });
  // The newest link is listed first.
  await rows
    .first()
    .getByRole("button", { name: /^End the link that works until/ })
    .click();
  await a
    .locator("wa-dialog[open]")
    .getByRole("button", { name: words("invite.end_link"), exact: true })
    .click();
  await expect(a.getByText(words("invite_link.link_ended"), { exact: true })).toBeVisible({
    timeout: 20_000,
  });
  await expect(rows).toHaveCount(1, { timeout: 20_000 });

  await b.goto("/join");
  await b.getByLabel("Invite link").fill(linkB);
  await b.getByRole("button", { name: "Ask to join", exact: true }).click();
  // 60 s: the ask travels to Ada's phone, which reads and refuses it.
  const ended = b.getByRole("dialog", { name: pattern("join_request.owner_ended_this_link") });
  await expect(ended).toBeVisible({ timeout: 60_000 });
  // Ada's phone has answered, so a request that was going to arrive would have by now.
  await a.waitForTimeout(5000);
  await expect(a.getByText(`wants to join “${ALBUM}”`)).toHaveCount(0);
  const saved = savedLinks(instances[0].storageDir);
  expect(saved.find((l) => l.to === endOf(linkB))?.ended).toEqual(expect.any(Number));
  const keptLink = saved.find((l) => l.to === endOf(linkA));
  expect(keptLink).toBeDefined();
  expect(keptLink).not.toHaveProperty("ended");

  await ended.getByRole("button", { name: words("invite.close") }).click();
  await b.goto("/join");
  await b.getByLabel("Invite link").fill(linkA);
  await b.getByRole("button", { name: "Ask to join", exact: true }).click();
  await expect(
    b.getByRole("dialog", { name: pattern("invite.waiting_for_to_let_you_in") }),
  ).toBeVisible({ timeout: 20_000 });
  await expect(a.getByText(`wants to join “${ALBUM}”`)).toBeVisible({ timeout: 60_000 });
  // The card names the link Ben came through: the 1-day one, not the ended 7-day one.
  await expect(a.getByText(pattern("album.asked_with_link"))).toContainText(
    `with the ${words("link_kind.1_day")} link`,
  );
  await a.getByRole("button", { name: "Accept, can only look", exact: true }).click();
  await expect(b).toHaveURL(/\/albums\/[^/]+$/, { timeout: 60_000 });
});
