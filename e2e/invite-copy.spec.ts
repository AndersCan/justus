import { expect, test, type Page } from "@playwright/test";

/** Safari's rule: a clipboard write must start inside the tap. */
async function clipboardNeedsTap(page: Page) {
  await page.addInitScript(() => {
    let inTap = false;
    document.addEventListener(
      "click",
      () => {
        inTap = true;
        setTimeout(() => (inTap = false), 0);
      },
      true,
    );
    const real = navigator.clipboard.writeText.bind(navigator.clipboard);
    const refuse = () => Promise.reject(new DOMException("outside the tap", "NotAllowedError"));
    navigator.clipboard.writeText = (v: string) => (inTap ? real(v) : refuse());
    const write = navigator.clipboard.write.bind(navigator.clipboard);
    navigator.clipboard.write = (items: ClipboardItems) => (inTap ? write(items) : refuse());
    (window as unknown as { clearClipboard: () => Promise<void> }).clearClipboard = () => real("");
  });
}

/** Holds the invite link's end-time save for `ms`. */
async function slowLinkSave(page: Page, ms: number) {
  await page.routeWebSocket(/.*/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const text = typeof m === "string" ? m : Buffer.from(m).toString("latin1");
      if (text.includes("photos.saveInviteLink")) setTimeout(() => server.send(m), ms);
      else server.send(m);
    });
    server.onMessage((m) => ws.send(m));
  });
}

for (const [name, hold] of [
  ["one tap on Copy right after a reload copies the link while its end time is still saving", 3000],
  ["one tap on Copy right after a reload copies the link when the save is quick", 0],
] as const) {
  test(name, async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await clipboardNeedsTap(page);
    await slowLinkSave(page, hold);
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
    await page.evaluate(() =>
      (window as unknown as { clearClipboard: () => Promise<void> }).clearClipboard(),
    );
    await page
      .locator(
        'button:has([data-copy-id="invite.copy_invite_link"]), button:has([data-copy-id="invite.copy_link"])',
      )
      .first()
      .click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()), { timeout: 10_000 })
      .toMatch(/^https:\/\/anderscan\.github\.io\/justus\/join\/#i=.*[#&]e=\d+/);
    await expect(page.locator('[data-copy-id="invite.copied_paste_it"]')).toBeVisible();
    await expect(page.locator(".justus-toast")).toHaveCount(0);
  });
}
