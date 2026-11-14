import { expect, test } from "@playwright/test";

test("an expired invite link says so under the box and sends nothing", async ({ page }) => {
  await page.goto("/join");
  const link = `justus://join?i=${"a".repeat(64)}&o=${"b".repeat(64)}&e=1&n=Trip&a=Nils`;
  await page.getByLabel("Invite link").fill(link);
  await page.getByRole("button", { name: "Ask to join", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "This invite link has expired. Ask Nils for a new one.",
  );
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByLabel("Invite link")).toHaveValue(link);
  await expect(page.getByRole("button", { name: /: Trip$/ })).toHaveCount(0);
});

test("text that is not a link says so under the box until you type", async ({ page }) => {
  await page.goto("/join");
  const box = page.getByLabel("Invite link");
  await box.fill("hello");
  await page.getByRole("button", { name: "Ask to join", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "That doesn't look like a Justus invite link. Copy the whole message from your chat, then tap Paste.",
  );
  await expect(box).toHaveValue("hello");
  await box.press("End");
  await box.pressSequentially("x");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("a waiting request can be cancelled and asked again", async ({ page }) => {
  const code = Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join(
    "",
  );
  const link = `justus://join?i=${code}&o=${"b".repeat(64)}&n=Cancel%20test&a=Nils`;
  const ask = async () => {
    await page.goto("/join");
    await page.getByLabel("Invite link").fill(link);
    await page.getByRole("button", { name: "Ask to join", exact: true }).click();
    return page.getByRole("dialog", { name: "You're done. Waiting for Nils to let you in." });
  };
  const waiting = await ask();
  await expect(waiting).toBeVisible({ timeout: 15_000 });
  await expect(page.getByLabel("Invite link")).toHaveValue("");
  await waiting.getByRole("button", { name: "Cancel request" }).click();
  await expect(waiting).toBeHidden();
  const row = page.getByRole("button", { name: "Waiting for Nils to accept: Cancel test" });
  await expect(row).toHaveCount(0);
  await page.reload();
  await expect(row).toHaveCount(0);
  const again = await ask();
  await expect(again).toBeVisible({ timeout: 15_000 });
  await again.getByRole("button", { name: "Cancel request" }).click();
});
