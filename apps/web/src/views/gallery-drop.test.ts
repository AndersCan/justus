// @vitest-environment happy-dom
import { describe, expect, test, vi } from "vite-plus/test";
import { render } from "lit-html";

vi.mock("../gateway", () => ({
  gateway: { list: vi.fn(), add: vi.fn(), upload: vi.fn(), remove: vi.fn() },
}));

import { galleryView } from "./gallery";

function dragEvent(type: string) {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, "dataTransfer", { value: { types: ["Files"], files: [] } });
  return e;
}

describe("photos page drop overlay", () => {
  test("dragenter shows the overlay, drop hides it", () => {
    const root = document.createElement("div");
    render(galleryView({ kind: "all" }) as never, root);
    const page = root.querySelector("[data-drop-overlay]")?.parentElement as HTMLElement;
    const overlay = root.querySelector("[data-drop-overlay]") as HTMLElement;
    expect(overlay.hidden).toBe(true);
    page.dispatchEvent(dragEvent("dragenter"));
    expect(overlay.hidden).toBe(false);
    page.dispatchEvent(dragEvent("drop"));
    expect(overlay.hidden).toBe(true);
  });
});
