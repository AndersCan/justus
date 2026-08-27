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

  await page.goto("/sharing");

  // The heading renders once the grants machine has loaded (not wedged on a
  // spinner).
  await expect(page.getByRole("heading", { name: "Sharing" })).toBeVisible({
    timeout: 20_000,
  });

  // A fresh seed has no pending unknown-holder prompts.
  await expect(page.getByText("No prompts right now.")).toBeVisible({ timeout: 20_000 });

  // And no one has been granted the album yet.
  await expect(page.getByText("Just you — invite someone to share.")).toBeVisible();

  expect(consoleErrors, `console errors:\n${consoleErrors.join("\n")}`).toEqual([]);
});

test("refreshing the sharing view keeps the honest empty states", async ({ page }) => {
  await page.goto("/sharing");
  const refresh = page.getByRole("button", { name: "Refresh" });
  await expect(refresh).toBeVisible({ timeout: 20_000 });

  // Refresh re-loads the ledger; the empty states must return (no wedge).
  await refresh.click();
  await expect(page.getByText("No prompts right now.")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Just you — invite someone to share.")).toBeVisible();
});
