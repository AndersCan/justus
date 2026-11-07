import { expect, test } from "@playwright/test";

const createButton = (page: import("@playwright/test").Page) =>
  page.getByRole("button", { name: "Create album" });

async function expectCoral(page: import("@playwright/test").Page) {
  const button = createButton(page);
  await expect(button).toBeVisible({ timeout: 20_000 });
  // The role query resolves to the real <button> inside the component's shadow DOM.
  const style = await button.evaluate((inner) => {
    const css = getComputedStyle(inner);
    return {
      background: css.backgroundColor,
      color: css.color,
      height: inner.getBoundingClientRect().height,
    };
  });
  expect(style.background).toBe("rgb(255, 138, 91)");
  expect(style.color).toBe("rgb(20, 18, 31)");
  const input = await page.getByLabel("Album name").boundingBox();
  expect(Math.abs(style.height - (input?.height ?? 0))).toBeLessThanOrEqual(1);
}

test("create button is coral with dark text", async ({ page }) => {
  await page.goto("/sharing");
  await expectCoral(page);
});

test.describe("dark", () => {
  test.use({ colorScheme: "dark" });
  test("create button keeps coral with dark text", async ({ page }) => {
    await page.goto("/sharing");
    await expectCoral(page);
    const canvas = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(canvas).toBe("rgb(15, 13, 26)");
  });
});

test("no request leaves the device", async ({ page }) => {
  const external: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.protocol === "data:" || url.protocol === "blob:") return;
    if (url.hostname !== "127.0.0.1") external.push(request.url());
  });
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __csp: string[] }).__csp = seen;
    document.addEventListener("securitypolicyviolation", (e) => seen.push(e.blockedURI));
  });
  await page.goto("/");
  await expect(page.locator("figure img").first()).toBeAttached({ timeout: 20_000 });
  for (const path of ["/sharing", "/settings"]) {
    await page.goto(path);
    await expect(page.getByRole("heading").first()).toBeVisible({ timeout: 20_000 });
  }
  await page.goto("/");
  await expect(page.locator("figure img").first()).toBeAttached({ timeout: 20_000 });
  await page.locator("figure").first().click();
  await page.getByRole("button", { name: "More options" }).click();
  await page.getByRole("menuitem", { name: "Remove from album" }).click();
  await expect(page.getByRole("dialog")).toBeVisible({ timeout: 5_000 });
  await page.getByRole("button", { name: "Keep" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 5_000 });
  const violations = await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);
  expect(external).toEqual([]);
  expect(violations).toEqual([]);
});
