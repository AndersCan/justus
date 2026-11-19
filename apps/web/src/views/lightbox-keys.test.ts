// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from "vite-plus/test";
import type { Photo } from "@justus/core";
import { openLightbox, closeLightbox } from "./lightbox";
import { openHolders } from "./photo-holders";
import { render } from "lit-html";
import { lightboxActor } from "../machines/lightbox-machine";
import { syncActor, statusSeen } from "../machines/sync-machine";
import { friendsActor } from "../machines/friends-machine";
import { lightboxView } from "./lightbox";
import { memberColor } from "../utils/palette";
import { galleryActor } from "../machines/gallery-machine";

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
const see = (id: string, members: unknown[]) =>
  syncActor.send(statusSeen.create({ status: { folder: { id }, members } as never }));
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

describe("Escape in a sheet over the photo", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    closeLightbox();
  });

  it("does not close the photo when a sheet such as Ask to join is open", () => {
    openLightbox(photo);
    const dialog = document.createElement("dialog");
    dialog.setAttribute("open", "");
    document.body.append(dialog);
    escape();
    expect(lightboxActor.snapshot().context.photo?.id).toBe("a");
  });
});

describe("holders sheet in the lightbox", () => {
  afterEach(() => {
    closeLightbox();
    vi.restoreAllMocks();
  });

  it("reads the photo's own people, whichever album is open", () => {
    const holders = {
      kind: "inAlbum" as const,
      here: true,
      previewHere: false,
      others: [{ key: "k1", name: "Ben", identity: "id-b", color: 1, connected: true }],
      quiet: [],
      unsure: [],
      waiting: [],
      previews: [],
      former: [],
      left: [],
      yourColor: 0,
    };
    vi.spyOn(friendsActor, "snapshot").mockReturnValue({
      context: { friends: { "id-b": "Benny" } },
    } as never);
    const rowsWhenOpen = (id: string) => {
      syncActor.send(
        statusSeen.create({ status: { folder: { id }, name: "Ada", members: [] } as never }),
      );
      openLightbox({ ...photo, folderId: "trip", holders });
      openHolders();
      const el = document.createElement("div");
      render(lightboxView(), el);
      const rows = [...el.querySelectorAll("dialog li")].map((li) => [
        li.querySelector(".text-fg")?.textContent?.trim(),
        li.querySelector("span[aria-hidden]")?.textContent?.trim(),
        li.querySelector("span[aria-hidden]")?.getAttribute("style"),
      ]);
      closeLightbox();
      return rows;
    };
    const inAlbum = rowsWhenOpen("trip");
    expect(inAlbum).toEqual([
      ["You", "AD", `background:${memberColor(0)}`],
      ["Benny", "BE", `background:${memberColor(1)}`],
    ]);
    expect(rowsWhenOpen("summer")).toEqual(inAlbum);
  });
});

describe("lightbox adder dot", () => {
  afterEach(() => {
    closeLightbox();
    vi.restoreAllMocks();
  });
  const open = (members: unknown[]) => {
    see("f1", members);
    openLightbox({ ...photo, folderId: "f1", member: { key: "k2", name: "Ben" } });
    const el = document.createElement("div");
    render(lightboxView(), el);
    return el;
  };
  const adder = (el: Element) => el.querySelector("span.h-2\\.5");
  const dot = (members: unknown[]) => adder(open(members));

  it("takes the adder's colour from Members", () => {
    const d = dot([
      { key: "k1", name: "Ada", admin: true, connected: true, color: 0 },
      { key: "k2", name: "Ben", admin: false, connected: true, color: 1 },
    ]);
    expect(d?.getAttribute("style")).toBe(`background:${memberColor(1)};`);
  });

  it("is hollow when the adder is not in the album", () => {
    const d = dot([{ key: "k1", name: "Ada", admin: true, connected: true, color: 0 }]);
    expect(d?.hasAttribute("style")).toBe(false);
    expect(d?.className).toContain("border-muted");
  });

  it("follows a status that arrives while the photo is open", () => {
    const ada = { key: "k1", name: "Ada", admin: true, connected: true, color: 0 };
    const el = open([ada, { key: "k2", name: "Ben", admin: false, connected: true }]);
    expect(adder(el)?.hasAttribute("style")).toBe(false);
    see("f1", [ada, { key: "k2", name: "Ben", admin: false, connected: true, color: 1 }]);
    expect(adder(el)?.getAttribute("style")).toBe(`background:${memberColor(1)};`);
  });

  it("gives no colour to the adder dot when the open status is another album", () => {
    see("f2", [{ key: "k2", name: "Ben", admin: false, connected: true, color: 1 }]);
    openLightbox({ ...photo, folderId: "f1", member: { key: "k2", name: "Ben" } });
    const el = document.createElement("div");
    render(lightboxView(), el);
    expect(adder(el)?.hasAttribute("style")).toBe(false);
  });

  it("matches the adder by key when two people share a name", () => {
    const d = dot([
      { key: "k1", name: "Ben", admin: true, connected: true, color: 0 },
      { key: "k2", name: "Ben", admin: false, connected: true, color: 1 },
    ]);
    expect(d?.getAttribute("style")).toBe(`background:${memberColor(1)};`);
  });
});

describe("swipe in the lightbox", () => {
  afterEach(() => {
    closeLightbox();
    vi.restoreAllMocks();
  });

  it("still steps when a status arrives between touchstart and touchend", () => {
    const mk = (id: string): Photo => ({ ...photo, id, name: id });
    const photos = [mk("a"), mk("b"), mk("c")];
    vi.spyOn(galleryActor, "snapshot").mockReturnValue({ context: { photos } } as never);
    openLightbox(photos[1]);
    const el = document.createElement("div");
    render(lightboxView(), el);
    const root = el.firstElementChild as Element;
    const touch = (type: string, x: number) => {
      const e = new Event(type, { bubbles: true });
      const list = [{ clientX: x, clientY: 0 }];
      Object.assign(e, { touches: list, changedTouches: list });
      root.dispatchEvent(e);
    };
    touch("touchstart", 300);
    see("f1", [{ key: "k1", name: "Ada", admin: true, connected: true, color: 0 }]);
    touch("touchend", 100);
    expect(lightboxActor.snapshot().context.photo?.id).toBe("c");
  });

  describe("down", () => {
    const swipe = (from: [number, number], to: [number, number]) => {
      const photos = [photo];
      vi.spyOn(galleryActor, "snapshot").mockReturnValue({ context: { photos } } as never);
      openLightbox(photo);
      const el = document.createElement("div");
      render(lightboxView(), el);
      const root = el.firstElementChild as Element;
      const touch = (type: string, [x, y]: [number, number]) => {
        const e = new Event(type, { bubbles: true });
        const list = [{ clientX: x, clientY: y }];
        Object.assign(e, { touches: list, changedTouches: list });
        root.dispatchEvent(e);
      };
      touch("touchstart", from);
      touch("touchend", to);
      return lightboxActor.snapshot().context.photo;
    };

    it("closes on a long swipe down", () => {
      expect(swipe([100, 100], [100, 220])).toBeUndefined();
    });
    it("ignores a short swipe down", () => {
      expect(swipe([100, 100], [100, 140])?.id).toBe(photo.id);
    });
    it("ignores a swipe up", () => {
      expect(swipe([100, 300], [100, 180])?.id).toBe(photo.id);
    });
    it("ignores a mostly sideways swipe", () => {
      expect(swipe([300, 100], [180, 190])?.id).toBe(photo.id);
    });
    it("closes when down is more than sideways, even under 1.5 times", () => {
      expect(swipe([100, 100], [200, 220])).toBeUndefined();
    });
    it("ignores a swipe of exactly 80 px down", () => {
      expect(swipe([100, 100], [100, 180])?.id).toBe(photo.id);
    });
  });
});

describe("close button in the lightbox", () => {
  afterEach(() => closeLightbox());

  it("sits in the viewer's top bar", () => {
    openLightbox(photo);
    const host = document.createElement("div");
    render(lightboxView(), host);
    expect(host.querySelector('[data-part="top"] button[aria-label="Close"]')).not.toBeNull();
  });
});
