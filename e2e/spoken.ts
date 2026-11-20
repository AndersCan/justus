// @ts-nocheck: the hub fixtures are untyped .mjs
/**
 * What a screen reader hears of the open confirm sheet, from Chromium's accessibility tree:
 * the dialog's name, the text shown in the sheet, and each button's name and description.
 */
export async function spokenSheet(page) {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { nodes } = await cdp.send("Accessibility.getFullAXTree");
    const byId = new Map(nodes.map((n) => [n.nodeId, n]));
    const dialog = nodes.find((n) => !n.ignored && n.role?.value === "dialog");
    const buttons = [];
    const walk = (n) => {
      if (!n.ignored && n.role?.value === "button") {
        buttons.push({ name: n.name?.value ?? "", description: n.description?.value ?? "" });
      }
      for (const id of n.childIds ?? []) walk(byId.get(id));
    };
    if (dialog) walk(dialog);
    const text = await page.locator("wa-dialog[open] p").innerText();
    return { name: dialog?.name?.value ?? "", shown: { text }, buttons };
  } finally {
    await cdp.detach();
  }
}
