import { expect, test } from "@playwright/test";

test("an expired invite link says so and sends nothing", async ({ page }) => {
  await page.goto("/join");
  await page
    .getByLabel("Invite link")
    .fill(`justus://join?i=${"a".repeat(64)}&o=${"b".repeat(64)}&e=1&n=Trip&a=Nils`);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "This invite link has expired." });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Ask Nils for a new one.")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Ask to join" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "OK" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: /: Trip$/ })).toHaveCount(0);
});

test("a waiting request can be cancelled and asked again", async ({ page }) => {
  const code = Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join(
    "",
  );
  const link = `justus://join?i=${code}&o=${"b".repeat(64)}&n=Cancel%20test&a=Nils`;
  const askName = "Ask to join “Cancel test”?";
  await page.goto("/join");
  await page.getByLabel("Invite link").fill(link);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("dialog", { name: askName })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Ask to join" }).click();
  const waiting = page.getByRole("dialog", {
    name: "You're done. Waiting for Nils to let you in.",
  });
  await expect(waiting).toBeVisible();
  await waiting.getByRole("button", { name: "Cancel request" }).click();
  await expect(waiting).toBeHidden();
  const row = page.getByRole("button", { name: "Waiting for Nils to accept: Cancel test" });
  await expect(row).toHaveCount(0);
  await page.reload();
  await expect(row).toHaveCount(0);
  await page.goto("/join");
  await page.getByLabel("Invite link").fill(link);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  const again = page.getByRole("dialog", { name: askName });
  await expect(again).toBeVisible({ timeout: 15_000 });
  await again.getByRole("button", { name: "Not now" }).click();
});
