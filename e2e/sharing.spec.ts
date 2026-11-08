import { expect, test } from "@playwright/test";

/**
 * Regression guard for the Sharing surface (issue #30 / #25, shipped in
 * #166–#168): the grant ledger + unknown-holder prompt cards must render
 * their honest empty states against the real stack — no console errors and
 * no loading wedge.
 */
test("sharing view shows honest empty states, no console errors", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  await page.goto("/devices");

  // The heading renders once the grants machine has loaded (not wedged on a
  // spinner).
  await expect(page.getByRole("heading", { name: "Sharing", exact: true })).toBeVisible({
    timeout: 20_000,
  });

  // A fresh seed has no pending unknown-holder prompts.
  await expect(page.getByText("No prompts right now.")).toBeVisible({ timeout: 20_000 });

  // And no one has been granted the album yet.
  await expect(page.getByText("Just you — invite someone to share.")).toBeVisible();

  expect(consoleErrors, `console errors:\n${consoleErrors.join("\n")}`).toEqual([]);
});

test("refreshing the sharing view keeps the honest empty states", async ({ page }) => {
  await page.goto("/devices");
  const refresh = page.getByRole("button", { name: "Refresh" });
  await expect(refresh).toBeVisible({ timeout: 20_000 });

  // Refresh re-loads the ledger; the empty states must return (no wedge).
  await refresh.click();
  await expect(page.getByText("No prompts right now.")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Just you — invite someone to share.")).toBeVisible();
});

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
  await expect(page.getByRole("dialog", { name: askName })).toBeVisible();
  await page.getByRole("button", { name: "Ask to join" }).click();
  const waiting = page.getByRole("dialog", { name: "Waiting for Nils" });
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
  await expect(again).toBeVisible();
  await again.getByRole("button", { name: "Not now" }).click();
});
