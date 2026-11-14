import { expect, test } from "@playwright/test";
import { openAlbum } from "./add-photos.js";

/**
 * A tapped photo grows into the viewer and shrinks back. Records the names of
 * every view-transition group while the transition runs.
 */
test("a tapped photo grows into the viewer and shrinks back", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    const w = window as any;
    w.__groups = [];
    const real = document.startViewTransition?.bind(document);
    if (!real) return;
    document.startViewTransition = ((cb: () => void) => {
      const t = real(cb);
      t.ready
        .then(() => {
          for (const a of document.getAnimations()) {
            const name = (a.effect as KeyframeEffect | null)?.pseudoElement;
            if (name?.startsWith("::view-transition-group(")) w.__groups.push(name);
          }
        })
        .catch(() => {});
      return t;
    }) as never;
  });
  await openAlbum(page);
  await page.evaluate(() => ((window as any).__groups = []));
  await page.locator("[data-photo-tile]").first().click();
  await expect(page.locator("[data-controls]")).toHaveAttribute("data-controls", "shown");
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("button", { name: "Close" })).toHaveCount(0);
  await expect(page.locator("[data-photo-tile][data-vt]")).toHaveCount(0);
  const groups = await page.evaluate(() => (window as any).__groups as string[]);
  expect(groups).toContain("::view-transition-group(photo)");
  expect(groups).not.toContain("::view-transition-group(album)");
});
