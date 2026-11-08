// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from "vite-plus/test";
import type { Photo } from "@justus/core";
import { openLightbox, closeLightbox } from "./lightbox";
import { openHolders } from "./photo-holders";
import { lightboxActor } from "../machines/lightbox-machine";

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
