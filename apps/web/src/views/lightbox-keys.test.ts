// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from "vite-plus/test";
import type { Photo } from "@justus/core";
import { openLightbox, closeLightbox } from "./lightbox";
import { openHolders } from "./photo-holders";
import { render } from "lit-html";
import { lightboxActor } from "../machines/lightbox-machine";
import { syncActor } from "../machines/sync-machine";
import { lightboxView } from "./lightbox";
import { memberColor } from "../utils/palette";

vi.mock("../gateway", () => ({
  gateway: { list: vi.fn(), add: vi.fn(), upload: vi.fn(), remove: vi.fn() },
}));

const photo: Photo = {
  id: "a",
  url: "blob:a",
  name: "a",
  mime: "image/jpeg",
  size: 1,
  addedAt: 0,
  member: { key: "m", name: "M" },
};
const escape = () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

describe("Escape in the lightbox", () => {
  afterEach(() => closeLightbox());

  it("closes only the holders sheet first, then the photo", () => {
    openLightbox(photo);
    openHolders();
    expect(lightboxActor.snapshot().path[0]).toBe("showingWhoHasThisPhoto");
    escape();
    expect(lightboxActor.snapshot().path[0]).toBe("showingPhoto");
    expect(lightboxActor.snapshot().context.photo?.id).toBe("a");
    escape();
    expect(lightboxActor.snapshot().context.photo).toBeUndefined();
  });
});

describe("holders sheet in the lightbox", () => {
  afterEach(() => {
    closeLightbox();
    vi.restoreAllMocks();
  });

  it("colours rows from the open album's people", () => {
    vi.spyOn(syncActor, "snapshot").mockReturnValue({
      context: {
        status: {
          folder: { id: "f1" },
          members: [{ key: "k1", name: "Ada", admin: true, connected: true }],
        },
      },
    } as never);
    openLightbox({
      ...photo,
      folderId: "f1",
      holders: { here: true, others: [], unsure: [], waiting: [], former: [], left: [] },
    });
    openHolders();
    const el = document.createElement("div");
    render(lightboxView(), el);
    const fill = el.querySelector('[role="dialog"] li span[style]')?.getAttribute("style");
    expect(fill).toBe(`background:${memberColor("k1")}`);
  });

  it("gives no Members colours when the open status is another album", () => {
    vi.spyOn(syncActor, "snapshot").mockReturnValue({
      context: {
        status: {
          folder: { id: "f2" },
          members: [{ key: "k1", name: "Ada", admin: true, connected: true }],
        },
      },
    } as never);
    openLightbox({
      ...photo,
      folderId: "f1",
      holders: { here: true, others: [], unsure: [], waiting: [], former: [], left: [] },
    });
    openHolders();
    const el = document.createElement("div");
    render(lightboxView(), el);
    const fill = el.querySelector('[role="dialog"] li span[style]')?.getAttribute("style");
    expect(fill).not.toBe(`background:${memberColor("k1")}`);
  });
});
