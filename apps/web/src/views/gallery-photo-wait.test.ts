// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vite-plus/test";
import { render } from "lit-html";
import { albumHeader, photoWaitLine } from "./gallery";

vi.mock("../gateway", () => ({
  gateway: { list: vi.fn(), add: vi.fn(), upload: vi.fn(), remove: vi.fn() },
}));

const ben = { key: "b", name: "Ben" };
const cara = { key: "c", name: "Cara" };
const text = (w: Parameters<typeof photoWaitLine>[0]) => {
  const el = document.createElement("div");
  render(photoWaitLine(w), el);
  return el;
};

describe("photoWaitLine", () => {
  it("names the one phone that lacks photos", () => {
    const el = text({ waitsFor: { count: 3, phones: [ben] } });
    expect(el.querySelector('[data-copy-id="gallery.photos_wait_for_one"]')?.textContent).toBe(
      "3 photos wait for Ben's phone",
    );
  });
  it("counts phones when several lack photos", () => {
    const el = text({ waitsFor: { count: 1, phones: [ben, cara] } });
    expect(el.textContent).toContain("1 photo waits for 2 phones");
  });
  it("shows both parts with a separator", () => {
    const el = text({ coming: 2, waitsFor: { count: 1, phones: [ben] } });
    expect(el.textContent?.replace(/\s+/g, " ").trim()).toBe(
      "2 photos coming · 1 photo waits for Ben's phone",
    );
  });
  it("shows coming alone without a separator", () => {
    const el = text({ coming: 1 });
    expect(el.textContent?.trim()).toBe("1 photo coming");
  });
  it("renders nothing for an empty wait", () => {
    expect(text({}).querySelector("[data-photo-wait]")).toBeNull();
  });
});

describe("albumHeader photo wait line", () => {
  const photo = {
    id: "p",
    folderId: "f1",
    url: "u",
    thumbUrl: "t",
    member: { key: "k0", name: "Me" },
    holders: {
      kind: "inAlbum",
      here: true,
      previewHere: false,
      others: [],
      quiet: [],
      unsure: [],
      waiting: [{ key: "k1", name: "Ada" }],
      previews: [],
      former: [],
      left: [],
    },
  };
  const status = {
    folder: { id: "f1" },
    members: [
      { key: "k0", name: "Me", connected: true },
      { key: "k1", name: "Ada", connected: true },
    ],
  };
  const draw = (album: object, photos: object[] = [photo]) => {
    const host = document.createElement("div");
    const page = { status, folders: [album], requests: [], photos, lastSync: 0 };
    render(albumHeader(page as never, album as never), host);
    return host;
  };

  it("shows under the presence strip", () => {
    expect(draw({ id: "f1", name: "Trip", role: "member" }).textContent).toContain(
      "1 photo waits for Ada's phone",
    );
  });
  it("counts only this album's photos", () => {
    const other = { ...photo, id: "q", folderId: "f2" };
    expect(draw({ id: "f1", name: "Trip", role: "member" }, [photo, other]).textContent).toContain(
      "1 photo waits for Ada's phone",
    );
  });
  it("shows nothing for an album with a notice", () => {
    const album = { id: "f1", name: "Trip", role: "member", notice: { kind: "moved" } };
    expect(draw(album).querySelector("[data-photo-wait]")).toBeNull();
  });
});
