import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const STATE = resolve(".dev-e2e/storage/justus.json");
const DAY = 24 * 60 * 60_000;

/** Holds the first save of a link's end time for `holdMs`; later saves pass at once. */
async function holdFirstLinkSave(page: Page, { holdMs }: { holdMs: number }) {
  let held = false;
  await page.routeWebSocket(/.*/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const text = typeof m === "string" ? m : Buffer.from(m).toString("latin1");
      if (!held && text.includes("photos.saveInviteLink")) {
        held = true;
        setTimeout(() => server.send(m), holdMs);
      } else server.send(m);
    });
    server.onMessage((m) => ws.send(m));
  });
}

/** The end times this phone saved for its albums' links. */
function savedEnds(): number[] {
  const state = JSON.parse(readFileSync(STATE, "utf8")) as {
    folders: { invite?: { links?: { to: number }[] } }[];
  };
  return state.folders.flatMap((f) => (f.invite?.links ?? []).map((l) => l.to));
}

test("copies a link that works for the time picked while its end time saved", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await holdFirstLinkSave(page, { holdMs: 3000 });
  await page.goto("/sharing");
  await page
    .getByRole("link", { name: /^Invite & members of / })
    .first()
    .click();
  await expect(page.getByRole("heading", { name: "Members" })).toBeVisible({ timeout: 20_000 });
  await page.reload();
  await expect(page.locator('[data-copy-id="invite.link_works_for"]')).toBeVisible({
    timeout: 20_000,
  });
  const picker = page.getByRole("combobox", { name: "Link works for" });
  await expect(picker).toHaveValue("1d");
  // With a link already shown, the button makes another one at the time picked before the tap.
  const another = page.locator('button:has([data-copy-id="invite.make_a_new_link"])');
  if (await another.isVisible()) await picker.selectOption("7d");
  await page.evaluate(() => navigator.clipboard.writeText(""));
  const tappedAt = Date.now();
  await page
    .locator(
      'button:has([data-copy-id="invite.copy_invite_link"]), button:has([data-copy-id="invite.copy_link"]), button:has([data-copy-id="invite.make_a_new_link"])',
    )
    .first()
    .click();
  await picker.selectOption("7d");
  await expect(picker).toHaveValue("7d");
  await expect(page.locator("[data-link-row]").first()).toBeVisible({
    timeout: 10_000,
  });
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()), { timeout: 10_000 })
    .toMatch(/[#&]e=\d+/);
  const link = await page.evaluate(() => navigator.clipboard.readText());
  const end = Number(/[#&]e=(\d+)/.exec(link)?.[1]) * 1000;
  expect(Math.abs(end - (tappedAt + 7 * DAY))).toBeLessThan(60_000);
  expect(savedEnds()).toContain(end);
});
