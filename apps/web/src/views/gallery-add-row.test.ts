// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { render } from "lit-html";
import { albumAddRow } from "./gallery";

vi.mock("../gateway", () => ({
  gateway: { list: vi.fn(), add: vi.fn(), upload: vi.fn(), remove: vi.fn() },
}));

const holiday = { id: "f1", name: "Holiday", role: "creator", members: 3 };
const trip = { id: "f2", name: "Trip", role: "creator", members: 3 };
const base = {
  done: 0,
  total: 1,
  added: 0,
  duplicates: 0,
  failed: [],
  running: false,
  folderId: "f1",
};
const rowFor = (album: typeof holiday, batch: object | null) => {
  const host = document.createElement("div");
  document.body.append(host);
  const page = { status: null, folders: [holiday, trip], requests: [], photos: [], batch };
  render(albumAddRow(page as never, album as never), host);
  return host;
};

afterEach(() => document.body.replaceChildren());

describe("add row progress", () => {
  test("idle: named button, no progress", () => {
    const host = rowFor(holiday, null);
    expect(host.textContent).toContain("Add photos to Holiday");
    expect(host.querySelector('[role="progressbar"]')).toBeNull();
  });

  test("adding here: button counts, bar and leave line show for any size", () => {
    for (const total of [1, 36]) {
      const host = rowFor(holiday, { ...base, total, done: 11 % total, running: true });
      const shown = Math.min((11 % total) + 1, total);
      expect(host.querySelector("wa-button")?.textContent).toContain(
        `Adding ${shown} of ${total}…`,
      );
      const bar = host.querySelector('[role="progressbar"]');
      expect(bar?.getAttribute("aria-valuemax")).toBe(String(total));
      expect(bar?.getAttribute("aria-valuenow")).toBe(String(11 % total));
      expect(host.textContent).toContain("You can leave this page.");
    }
  });

  test("adding to another album: normal label, disabled, no progress", () => {
    const host = rowFor(trip, { ...base, total: 36, done: 11, running: true });
    const button = host.querySelector("wa-button");
    expect(button?.textContent).toContain("Add photos to Trip");
    expect(button?.hasAttribute("disabled")).toBe(true);
    expect(host.querySelector('[role="progressbar"]')).toBeNull();
  });

  test("failures show their card in the row of that album only", () => {
    const failed = {
      ...base,
      total: 2,
      added: 1,
      failed: [{ source: { kind: "path", path: "/x.jpg", name: "x.jpg" } }],
    };
    const here = rowFor(holiday, failed);
    expect(here.querySelector('[role="alert"]')?.textContent).toContain("x.jpg");
    expect(rowFor(trip, failed).querySelector('[role="alert"]')).toBeNull();
  });
});
